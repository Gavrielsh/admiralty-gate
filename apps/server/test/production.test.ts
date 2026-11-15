import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildApp, type App, type AppOptions } from '../src/app.js';
import { HttpEmbedding, MockEmbedding, chooseEmbedding } from '../src/fusion/embedding.js';
import { IpResolver, PlaceResolver } from '../src/fusion/georesolve.js';
import { PgStore } from '../src/fusion/pgstore.js';
import { BullQueue } from '../src/fusion/queue.js';
import { MemoryStore } from '../src/fusion/store.js';
import type { Store } from '../src/fusion/types.js';
import { parseTelegramChannels } from '../src/collectors/runner.js';

const PG = process.env.TEST_DATABASE_URL;
const REDIS = process.env.TEST_REDIS_URL;
const backends: { name: string; make: () => { store: Store; redisUrl?: string; queuePrefix?: string } }[] = [
  { name: 'memory', make: () => ({ store: new MemoryStore() }) },
  ...(PG ? [{ name: 'PostgreSQL + PostGIS + pgvector', make: () => ({ store: new PgStore(PG, `p_${randomBytes(6).toString('hex')}`), ...(REDIS ? { redisUrl: REDIS, queuePrefix: `p-${randomBytes(6).toString('hex')}` } : {}) }) }] : []),
];
const pgOnly = backends.filter(b => b.name !== 'memory');

const apps: App[] = [];
const schemas = new Set<string>();
const servers: Server[] = [];
async function mk(backend: (typeof backends)[number], opts: Partial<AppOptions> = {}): Promise<App & { dir: string }> {
  const dir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'ag-prod-'));
  const b = opts.store ? {} : backend.make();
  const app = await buildApp({ dataDir: dir, stepDelayMs: 0, env: {}, policyWatchMs: 0, embedding: new MockEmbedding(), ...b, ...opts });
  if (app.store instanceof PgStore) schemas.add((app.store as unknown as { schema: string }).schema);
  apps.push(app);
  return { ...app, dir };
}
afterEach(async () => {
  for (const a of apps.splice(0)) {
    try {
      await a.fusion.idle();
      if (a.queue instanceof BullQueue) await a.queue.obliterate();
    } catch {
      /* already closed by the test */
    }
    await a.fastify.close();
  }
  for (const s of servers.splice(0)) s.close();
});
afterAll(async () => {
  for (const schema of schemas) {
    const admin = new PgStore(PG!, schema);
    await admin.dropSchema();
    await admin.close();
  }
});
const schemaOf = (a: App): string => (a.store as unknown as { schema: string }).schema;
const get = async <T>(app: App, url: string, headers: Record<string, string> = {}): Promise<T> => {
  const r = await app.fastify.inject({ url, headers });
  expect(r.statusCode, `${url} -> ${r.body}`).toBe(200);
  return r.json() as T;
};
const post = (app: App, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.fastify.inject({ method: 'POST', url, ...(payload === undefined ? {} : { payload: payload as object }), headers });
const waitFor = (app: App, type: string): Promise<{ data: unknown }> =>
  new Promise(resolve => {
    const hit = app.bus.since().find(e => e.type === type);
    if (hit) return resolve(hit);
    const off = app.bus.subscribe(e => e.type === type && (off(), resolve(e)));
  });
const listen = (handler: (url: string, body: string) => { status?: number; json: unknown }): Promise<{ url: string; hits: string[] }> =>
  new Promise(resolve => {
    const hits: string[] = [];
    const s = createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        hits.push(req.url ?? '');
        const r = handler(req.url ?? '', body);
        res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.json));
      });
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, hits }));
  });

describe('API key authentication', () => {
  const KEY = 'k-' + 'a'.repeat(30);

  it('protects every /api route and the event stream; only the health probe is open', async () => {
    const app = await mk(backends[0]!, { env: { ADMIRALTY_API_KEY: KEY } });
    for (const url of ['/api/policy', '/api/audit', '/api/approvals', '/api/provenance', '/api/geo/incidents', '/api/calls', '/api/fusion/status', '/events', '/api/events']) {
      expect((await app.fastify.inject({ url })).statusCode, url).toBe(401);
      expect((await app.fastify.inject({ url, headers: { authorization: 'Bearer wrong-key' } })).statusCode, url).toBe(401);
      expect((await app.fastify.inject({ url, headers: { 'x-api-key': KEY.slice(0, -1) } })).statusCode, url).toBe(401);
    }
    for (const [method, url] of [['POST', '/api/sandbox/run'], ['PUT', '/api/policy'], ['POST', '/api/approvals/x'], ['POST', '/api/ingest'], ['POST', '/api/audit/tamper'], ['POST', '/api/fusion/demo']] as const)
      expect((await app.fastify.inject({ method, url, payload: {} })).statusCode, url).toBe(401);
    const denied = await app.fastify.inject({ url: '/api/policy' });
    expect(denied.headers['www-authenticate']).toBe('Bearer');

    await get(app, '/api/policy', { authorization: `Bearer ${KEY}` });
    await get(app, '/api/policy', { 'x-api-key': KEY });
    expect(await get<{ ok: boolean; authRequired: boolean }>(app, '/api/health')).toMatchObject({ ok: true, authRequired: true });
    // The browser's CORS preflight carries no credentials and must still be answered.
    const pre = await app.fastify.inject({ method: 'OPTIONS', url: '/api/policy', headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,content-type' } });
    expect(pre.statusCode).toBe(204);
    expect(String(pre.headers['access-control-allow-headers'])).toContain('authorization');
  });

  it('streams events over a real socket only with the key', async () => {
    const app = await mk(backends[0]!, { env: { ADMIRALTY_API_KEY: KEY } });
    const base = await app.fastify.listen({ port: 0, host: '127.0.0.1' });
    expect((await fetch(`${base}/events`)).status).toBe(401);
    const ctl = new AbortController();
    const res = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${KEY}` }, signal: ctl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const first = new TextDecoder().decode((await res.body!.getReader().read()).value);
    expect(first).toContain('event: hello');
    ctl.abort();
  });

  it('the ledger webhook keeps its own HMAC authentication and needs no API key', async () => {
    const app = await mk(backends[0]!, { env: { ADMIRALTY_API_KEY: KEY, LEDGER_WEBHOOK_SECRET: 's3' } });
    const body = JSON.stringify({ events: [{ id: 'e1', account: 'a1' }] });
    const ts = Date.now();
    const unsigned = await app.fastify.inject({ method: 'POST', url: '/api/ingest/ledger', payload: body, headers: { 'content-type': 'application/json' } });
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.body).toContain('x-admiralty-timestamp');
    const sig = createHmac('sha256', 's3').update(`${ts}.${body}`).digest('hex');
    const ok = await app.fastify.inject({ method: 'POST', url: '/api/ingest/ledger', payload: body, headers: { 'content-type': 'application/json', 'x-admiralty-timestamp': String(ts), 'x-admiralty-signature': `sha256=${sig}` } });
    expect(ok.statusCode).toBe(202);
  });

  it('without a key the server only agrees to bind to loopback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag-prod-'));
    await expect(buildApp({ dataDir: dir, env: {}, host: '0.0.0.0', embedding: new MockEmbedding(), policyWatchMs: 0 })).rejects.toThrow(/Refusing to listen on 0\.0\.0\.0 without ADMIRALTY_API_KEY/);
    const open = await mk(backends[0]!, { host: '0.0.0.0', env: { ADMIRALTY_API_KEY: KEY } });
    expect((await open.fastify.inject({ url: '/api/policy' })).statusCode).toBe(401);
    // Loopback without a key: the local-development default.
    await get(await mk(backends[0]!, { host: '127.0.0.1' }), '/api/policy');
  });
});

describe.each(backends)('persisted calls, approvals and incident history on $name', backend => {
  it('records every tool call and every approval with its outcome', async () => {
    const app = await mk(backend);
    const run = async (scenarioId: string, approve?: boolean) => {
      const before = app.bus.since().length;
      const id = ((await post(app, '/api/sandbox/run', { mode: 'simulated', scenarioId })).json() as { runId: string }).runId;
      if (approve !== undefined) {
        const asked = await new Promise<{ data: { approval: { id: string } } }>(resolve => {
          const hit = app.bus.since().slice(before).find(e => e.type === 'approval.requested');
          if (hit) return resolve(hit as never);
          const off = app.bus.subscribe(e => e.type === 'approval.requested' && (off(), resolve(e as never)));
        });
        await post(app, `/api/approvals/${asked.data.approval.id}`, { approve });
      }
      return app.runFinished(id);
    };
    await run('injection-plain');
    await run('publish', true);
    await run('tainted-infra', false);

    const calls = (await get<{ calls: { id: string; tool: string; gate: string; status: string; approval?: { state: string } }[]; store: string }>(app, '/api/calls')).calls;
    expect(calls.map(c => [c.tool, c.gate, c.status]).reverse()).toEqual([
      ['search_news', 'ALLOW', 'executed'], ['find_username', 'BLOCK', 'blocked'], ['send_alert', 'ELICIT', 'executed'], ['search_news', 'ALLOW', 'executed'], ['whois', 'ELICIT', 'blocked'],
    ]);
    expect(new Set(calls.map(c => c.id)).size).toBe(5);
    const history = (await get<{ approvals: { tool: string; state: string; resolvedAt?: number; reasons: string[] }[] }>(app, '/api/approvals/history')).approvals;
    expect(history.map(a => [a.tool, a.state]).reverse()).toEqual([['send_alert', 'approved'], ['whois', 'denied']]);
    expect(history.every(a => typeof a.resolvedAt === 'number' && a.reasons.length > 0)).toBe(true);
  });

  it('keeps a history of how an incident\'s status changed', async () => {
    const app = await mk(backend);
    const ingest = async (items: unknown[]) => {
      expect((await post(app, '/api/ingest', { items })).statusCode).toBe(202);
      await app.fusion.idle();
    };
    await ingest([{ text: 'Bridge closed after a collision, police say.', sourceType: 'feed', sourceId: 'wire', grade: 'B2', claim: 'bridge' }]);
    await ingest([{ text: 'Transport ministry confirms the bridge is shut to traffic.', sourceType: 'web', sourceId: 'ministry', grade: 'A2', claim: 'bridge' }]);
    await ingest([{ text: 'City hall: the bridge is open, the report is false.', sourceType: 'web', sourceId: 'city-hall', grade: 'A2', claim: 'bridge', stance: 'contradicts' }]);
    const h = (await get<{ history: { status: string; released: boolean; independentSupport: number; rawItems: number; reasons: string[] }[] }>(app, '/api/incidents/claim:bridge/history')).history;
    expect(h.map(x => [x.status, x.independentSupport, x.rawItems])).toEqual([['quarantined', 1, 1], ['released', 2, 2], ['quarantined', 2, 3]]);
    expect(h[2]!.reasons.join(' ')).toContain('contradiction');
    expect((await app.fastify.inject({ url: '/api/incidents/claim:nope/history' })).statusCode).toBe(404);
  });
});

describe.each(pgOnly)('restart on $name: nothing recorded is lost', backend => {
  it('calls, approvals, incident history and audit mirror survive; an approval left pending is marked expired', async () => {
    const first = await mk(backend);
    const runId = ((await post(first, '/api/sandbox/run', { mode: 'simulated', scenarioId: 'publish' })).json() as { runId: string }).runId;
    const asked = (await waitFor(first, 'approval.requested')).data as { approval: { id: string } };
    await post(first, `/api/approvals/${asked.approval.id}`, { approve: true });
    await first.runFinished(runId);
    await post(first, '/api/ingest', { items: [{ text: 'Bridge closed, police say.', sourceType: 'feed', sourceId: 'wire', grade: 'B2', claim: 'bridge' }] });
    await first.fusion.idle();
    // A process that dies with a call paused leaves a pending row behind.
    await first.store.putApproval({ id: 'apr_crashed_1', callId: 'call_crashed_1', sessionId: 'run_x', tool: 'whois', args: { domain: 'x.example' }, reasons: ['needs approval'], provenance: [], requestedAt: Date.now() - 1000, expiresAt: Date.now() + 299_000, state: 'pending' });
    const schema = schemaOf(first);
    if (first.queue instanceof BullQueue) await first.queue.obliterate();
    await first.fastify.close();

    const second = await mk(backend, { dataDir: first.dir, store: new PgStore(PG!, schema) });
    const calls = (await get<{ calls: { tool: string; status: string; approval?: { state: string } }[]; store: string }>(second, '/api/calls'));
    expect(calls.store).toBe('postgres');
    expect(calls.calls.map(c => [c.tool, c.status, c.approval?.state])).toEqual([['send_alert', 'executed', 'approved']]);
    const approvals = (await get<{ approvals: { id: string; tool: string; state: string; note?: string }[] }>(second, '/api/approvals/history')).approvals;
    expect(approvals.map(a => [a.tool, a.state]).sort()).toEqual([['send_alert', 'approved'], ['whois', 'expired']]);
    expect(approvals.find(a => a.state === 'expired')!.note).toContain('not executed');
    // The expired approval is not offered for an answer, and answering it does nothing.
    expect((await get<{ pending: unknown[] }>(second, '/api/approvals')).pending).toEqual([]);
    expect((await post(second, '/api/approvals/apr_crashed_1', { approve: true })).statusCode).toBe(404);
    expect((await get<{ history: unknown[] }>(second, '/api/incidents/claim:bridge/history')).history).toHaveLength(1);
    const audit = await get<{ chainValid: boolean; entries: { kind: string; data: { count?: number } }[]; mirror: { inSync: boolean } }>(second, '/api/audit');
    expect(audit.chainValid).toBe(true);
    expect(audit.entries.filter(e => e.kind === 'approvals.expired').map(e => e.data.count)).toEqual([1]);
    expect(audit.mirror.inSync).toBe(true);
    // New ids do not collide with the ones recorded before the restart.
    const again = ((await post(second, '/api/sandbox/run', { mode: 'simulated', scenarioId: 'benign-lookup' })).json() as { runId: string }).runId;
    await second.runFinished(again);
    expect((await get<{ calls: unknown[] }>(second, '/api/calls')).calls).toHaveLength(2);
  });
});

describe.each(backends)('fraud rings computed in the store on $name', backend => {
  const secret = 'ring-secret';
  const send = async (app: App, events: unknown[]) => {
    const body = JSON.stringify({ events });
    const ts = Date.now();
    const r = await app.fastify.inject({ method: 'POST', url: '/api/ingest/ledger', payload: body, headers: { 'content-type': 'application/json', 'x-admiralty-timestamp': String(ts), 'x-admiralty-signature': `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}` } });
    expect(r.statusCode, r.body).toBe(202);
    await app.fusion.idle();
  };
  // Straight from the store: these events carry no coordinates, so their rings are not on the map.
  const rings = async (app: App) => (await app.store.queryIncidents({ kind: 'ring' })).map(r => ({ kind: r.kind, title: r.title, rawItems: r.rawItems, sharedIndicators: r.sharedIndicators }));
  const now = Date.now();

  it('groups by shared indicator, drops hub indicators and events outside the time window', async () => {
    const app = await mk(backend, { env: { LEDGER_WEBHOOK_SECRET: secret, RING_WINDOW_HOURS: '24' } });
    await send(app, [
      // Ten recent events. Six accounts use the same exchange wallet (a hub: more than half of the events)...
      ...[0, 1, 2, 3, 4, 5].map(i => ({ id: `h${i}`, account: `hub-${i}`, wallet: '0x' + '11'.repeat(20), at: now - i * 1000 })),
      // ...three accounts share one device (a ring)...
      ...[0, 1, 2].map(i => ({ id: `r${i}`, account: `ring-${i}`, device: 'fp-ring', at: now - i * 1000 })),
      { id: 'solo', account: 'solo', device: 'fp-solo', at: now },
      // ...and three more shared a device a month ago: outside the window.
      ...[0, 1, 2].map(i => ({ id: `old${i}`, account: `old-${i}`, device: 'fp-old', at: now - 30 * 86_400_000 })),
    ]);
    const found = await rings(app);
    expect(found.map(r => [r.rawItems, r.sharedIndicators])).toEqual([[3, ['device:fp-ring']]]);
  });

  it('one account\'s events bridge two groups; a proxy address links nobody', async () => {
    const app = await mk(backend, { env: { LEDGER_WEBHOOK_SECRET: secret } });
    await send(app, [
      { id: 'a1', account: 'acct-a', wallet: '0x' + 'aa'.repeat(20), at: now },
      { id: 'b1', account: 'acct-b', wallet: '0x' + 'aa'.repeat(20), at: now },
      // acct-b's second event carries a different device, which acct-c also uses.
      { id: 'b2', account: 'acct-b', device: 'fp-bc', at: now },
      { id: 'c1', account: 'acct-c', device: 'fp-bc', at: now },
      // An event of acct-a with no indicator at all still belongs to the ring: it is the same account.
      { id: 'a2', account: 'acct-a', at: now },
      // Three strangers behind one VPN exit.
      ...[0, 1, 2].map(i => ({ id: `v${i}`, account: `vpn-${i}`, ip: '203.0.113.50', proxy: true, at: now })),
    ]);
    const found = await rings(app);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rawItems: 5, title: '3 accounts linked by 2 shared indicator(s)' });
  });

  it('with RING_PROXIMITY_KM, events from different accounts at the same place and time form a ring (ST_DWithin in PostgreSQL)', async () => {
    const atm = { lat: 34.6786, lon: 33.0413 };
    const events = [
      // Three accounts at one ATM within four minutes, nothing else in common.
      { id: 'p0', account: 'walk-0', lat: atm.lat, lon: atm.lon, at: now - 240_000 },
      { id: 'p1', account: 'walk-1', lat: atm.lat + 0.0003, lon: atm.lon + 0.0002, at: now - 120_000 },
      { id: 'p2', account: 'walk-2', lat: atm.lat - 0.0002, lon: atm.lon + 0.0004, at: now },
      // Same place, but hours later: not the same visit.
      { id: 'late', account: 'walk-3', lat: atm.lat, lon: atm.lon, at: now - 6 * 3_600_000 },
      // Same time, 2 km away.
      { id: 'far', account: 'walk-4', lat: atm.lat + 0.018, lon: atm.lon, at: now - 60_000 },
    ];
    const off = await mk(backend, { env: { LEDGER_WEBHOOK_SECRET: secret } });
    await send(off, events);
    expect(await rings(off)).toEqual([]);

    const on = await mk(backend, { env: { LEDGER_WEBHOOK_SECRET: secret, RING_PROXIMITY_KM: '0.1', RING_PROXIMITY_WINDOW_MIN: '10' } });
    await send(on, events);
    const found = await rings(on);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rawItems: 3 });
    // The store query itself: exactly the three co-located pairs, whichever backend answers.
    const pairs = await on.store.proximityPairs({ radiusM: 100, windowMs: 600_000 });
    expect(pairs.map(p => p.map(x => x.split(':').pop()).join('-')).sort()).toEqual(['p0-p1', 'p0-p2', 'p1-p2']);
    expect(await on.store.proximityPairs({ radiusM: 100, windowMs: 60_000 })).toEqual([]);
    expect((await on.store.proximityPairs({ radiusM: 3000, windowMs: 600_000 })).length).toBeGreaterThan(3);
  });
});

describe('embedding providers', () => {
  /** An OpenAI-compatible endpoint whose vectors encode topic, not wording: axis 0 = strike, axis 1 = explosion. */
  const topicServer = (dim: number) =>
    listen((_url, body) => {
      const { input, model } = JSON.parse(body) as { input: string[]; model: string };
      expect(model).toBe('test-model');
      return {
        json: {
          data: input.map((t, index) => {
            const v = new Array<number>(dim).fill(0);
            if (/strike|שביתה|إضراب/.test(t)) v[0] = 1;
            else if (/explosion|פיצוץ|انفجار/.test(t)) v[1] = 1;
            else v[2 + (t.length % (dim - 2))] = 1;
            return { index, embedding: v.map(x => x * 3) };
          }),
        },
      };
    });

  it('HTTP provider: batches, normalises, learns its dimension and reports failures', async () => {
    const srv = await topicServer(8);
    const p = new HttpEmbedding(`${srv.url}/v1/embeddings`, 'test-model', 'sk-x', fetch, 2);
    await p.init();
    expect(p.dim).toBe(8);
    const v = await p.embed(['strike at the port', 'שביתה בנמל', 'explosion', 'weather', 'sports']);
    expect(v).toHaveLength(5);
    expect(v.every(x => Math.abs(Math.hypot(...x) - 1) < 1e-9)).toBe(true);
    expect(v[0]).toEqual(v[1]);
    expect(srv.hits.length).toBe(1 + 3); // the probe, then three batches of two
    const broken = await listen(() => ({ status: 500, json: {} }));
    await expect(new HttpEmbedding(broken.url, 'm', undefined).init()).rejects.toThrow(/HTTP 500/);
    const short = await listen(() => ({ json: { data: [] } }));
    await expect(new HttpEmbedding(short.url, 'm', undefined).init()).rejects.toThrow(/different number of vectors/);
  });

  it('chooseEmbedding: mock on request; a provider that cannot start degrades to the mock and says why', async () => {
    expect((await chooseEmbedding({ EMBEDDING_PROVIDER: 'mock' })).provider).toMatchObject({ semantic: false, dim: 256 });
    const noUrl = await chooseEmbedding({ EMBEDDING_PROVIDER: 'http' });
    expect(noUrl.provider.semantic).toBe(false);
    expect(noUrl.degraded).toContain('EMBEDDING_API_URL is not set');
    const dead = await chooseEmbedding({ EMBEDDING_PROVIDER: 'http', EMBEDDING_API_URL: 'http://127.0.0.1:9/v1/embeddings' });
    expect(dead.degraded).toContain('could not be loaded');
    expect((await chooseEmbedding({ EMBEDDING_PROVIDER: 'telepathy' })).degraded).toContain('unknown EMBEDDING_PROVIDER');
    const srv = await topicServer(8);
    const ok = await chooseEmbedding({ EMBEDDING_PROVIDER: 'http', EMBEDDING_API_URL: srv.url, EMBEDDING_MODEL: 'test-model' });
    expect(ok.degraded).toBeUndefined();
    expect(ok.provider).toMatchObject({ semantic: true, dim: 8 });
  });

  describe.each(backends)('semantic scores reach the core on $name', backend => {
    it('a translated repost inside the burst window is one origin; the same story a day later stays independent', async () => {
      const srv = await topicServer(8);
      const embedding = new HttpEmbedding(srv.url, 'test-model', undefined);
      const app = await mk(backend, { embedding });
      const t0 = Date.now() - 3 * 86_400_000;
      await post(app, '/api/ingest', { items: [
        { text: 'Dock workers strike at Limassol port', sourceType: 'feed', sourceId: 'wire', grade: 'B2', claim: 'strike', at: t0 },
        { text: 'שביתה של עובדי הנמל בלימסול', sourceType: 'telegram', sourceId: 'he-channel', grade: 'C3', claim: 'strike', at: t0 + 120_000 },
        { text: 'إضراب عمال الميناء في ليماسول', sourceType: 'telegram', sourceId: 'ar-channel', grade: 'C3', claim: 'strike', at: t0 + 86_400_000 },
      ] });
      await app.fusion.idle();
      const st = await get<{ embedding: { provider: string; dim: number; semantic: boolean } }>(app, '/api/fusion/status');
      expect(st.embedding).toEqual({ provider: 'http (test-model)', dim: 8, semantic: true });

      type V = { independentClusters: number; assessment: { links: { a: string; b: string; reason: string }[]; flags: string[] } };
      const v = (await post(app, '/api/corroborate', { claim: 'strike' })).json() as V;
      expect(v.independentClusters).toBe(2);
      expect(v.assessment.links.filter(l => l.reason === 'semantic')).toHaveLength(1);
      expect(v.assessment.flags).toContain('coordinated');
      // Without the semantic signal the three share no wording and look like three origins.
      expect(((await post(app, '/api/corroborate', { claim: 'strike', options: { semantic: false } })).json() as V).independentClusters).toBe(3);

      // Grounding: an English sentence backed only by the Hebrew post is a paraphrase, not ungrounded.
      const g = (await post(app, '/api/grounding', { report: 'Port workers went on strike. A meteor landed nearby.', sources: [{ id: 'he-channel', kind: 'telegram', grade: 'C3', text: 'שביתה של עובדי הנמל בלימסול' }] })).json() as { sentences: { level: string; semanticScore?: number; bestGrade?: string }[] };
      expect(g.sentences.map(s => s.level)).toEqual(['paraphrase', 'ungrounded']);
      expect(g.sentences[0]).toMatchObject({ bestGrade: 'C3' });
      expect(g.sentences[0]!.semanticScore).toBeCloseTo(1, 5);
      // Nearest-neighbour search uses the provider's vectors: an English query finds the Hebrew and Arabic posts.
      const near = await get<{ items: { sourceId: string }[] }>(app, `/api/provenance?limit=3&q=${encodeURIComponent('strike')}`);
      expect(near.items.map(i => i.sourceId).sort()).toEqual(['ar-channel', 'he-channel', 'wire']);
    });
  });

  describe.each(pgOnly)('changing the model on $name', backend => {
    it('rebuilds the vector column for the new dimension and re-embeds what is stored', async () => {
      const first = await mk(backend, { embedding: new MockEmbedding(256) });
      await post(first, '/api/ingest', { items: [
        { text: 'Dock workers strike at Limassol port', sourceType: 'feed', sourceId: 'wire', grade: 'B2' },
        { text: 'Explosion reported near the refinery', sourceType: 'feed', sourceId: 'other', grade: 'B2' },
      ] });
      await first.fusion.idle();
      const schema = schemaOf(first);
      if (first.queue instanceof BullQueue) await first.queue.obliterate();
      await first.fastify.close();

      const srv = await topicServer(12);
      const second = await mk(backend, { dataDir: first.dir, store: new PgStore(PG!, schema), embedding: new HttpEmbedding(srv.url, 'test-model', undefined) });
      expect((await get<{ embedding: { dim: number } }>(second, '/api/fusion/status')).embedding.dim).toBe(12);
      // The stored items were re-embedded with the new model: a Hebrew query now finds the English strike report.
      const near = await get<{ items: { sourceId: string }[] }>(second, `/api/provenance?limit=1&q=${encodeURIComponent('שביתה')}`);
      expect(near.items.map(i => i.sourceId)).toEqual(['wire']);
      // And new items are stored at the new length.
      await post(second, '/api/ingest', { items: [{ text: 'פיצוץ ליד בית הזיקוק', sourceType: 'telegram', sourceId: 'he', grade: 'C3' }] });
      await second.fusion.idle();
      expect((await get<{ total: number }>(second, '/api/provenance')).total).toBe(3);
    });
  });
});

const CITY = fileURLToPath(new URL('./data/GeoIP2-City-Test.mmdb', import.meta.url));
const ASN = fileURLToPath(new URL('./data/GeoLite2-ASN-Test.mmdb', import.meta.url));
const haveMmdb = existsSync(CITY) && existsSync(ASN);

describe('GeoIP', () => {
  it.skipIf(!haveMmdb)('reads MaxMind city and ASN databases; the operator CSV takes precedence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag-geo-'));
    writeFileSync(join(dir, 'geo.csv'), '214.0.1.0/24,34.68,33.04,override\n');
    const r = await IpResolver.open({ MAXMIND_CITY_DB_PATH: CITY, MAXMIND_ASN_DB_PATH: ASN, GEOIP_CSV: join(dir, 'geo.csv') });
    expect(r.sources).toEqual(['csv (1 ranges)', 'maxmind city', 'maxmind asn']);
    expect(r.lookup('214.0.0.5')).toEqual({ point: { lat: 1.336, lon: 103.7716 }, source: 'maxmind', asn: '721', org: 'DoD Network Information Center' });
    expect(r.lookup('214.0.1.9')).toMatchObject({ point: { lat: 34.68, lon: 33.04 }, source: 'csv', asn: '721' });
    expect(r.lookup('1.128.0.1')).toEqual({ source: 'maxmind', asn: '1221', org: 'Telstra Pty Ltd' });
    expect(r.lookup('203.0.113.9')).toBeUndefined();
    expect(r.lookup('not-an-ip')).toBeUndefined();
  });

  it('a missing or unreadable database is noted and the server carries on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag-geo-'));
    writeFileSync(join(dir, 'garbage.mmdb'), 'this is not an mmdb file');
    const r = await IpResolver.open({ MAXMIND_CITY_DB_PATH: join(dir, 'absent.mmdb'), MAXMIND_ASN_DB_PATH: join(dir, 'garbage.mmdb') });
    expect(r.sources).toEqual([]);
    expect(r.notes).toHaveLength(2);
    expect(r.notes[0]).toContain('not found');
    expect(r.notes[1]).toContain('cannot read');
    expect(r.lookup('214.0.0.5')).toBeUndefined();
    const app = await mk(backends[0]!, { env: { MAXMIND_CITY_DB_PATH: join(dir, 'absent.mmdb') } });
    expect((await get<{ geoip: { sources: string[]; notes: string[] } }>(app, '/api/fusion/status')).geoip).toMatchObject({ sources: [], notes: [expect.stringContaining('not found')] });
  });

  it.skipIf(!haveMmdb)('end to end: a ledger event whose address geolocates far from its claimed position is flagged, and its ASN recorded', async () => {
    const app = await mk(backends[0]!, { env: { LEDGER_WEBHOOK_SECRET: 's', MAXMIND_CITY_DB_PATH: CITY, MAXMIND_ASN_DB_PATH: ASN } });
    const body = JSON.stringify({ events: [{ id: 'e1', account: 'a1', ip: '214.0.0.5', lat: 34.68, lon: 33.04 }, { id: 'e2', account: 'a2', ip: '214.0.0.6', lat: 1.34, lon: 103.8 }] });
    const ts = Date.now();
    await app.fastify.inject({ method: 'POST', url: '/api/ingest/ledger', payload: body, headers: { 'content-type': 'application/json', 'x-admiralty-timestamp': String(ts), 'x-admiralty-signature': `sha256=${createHmac('sha256', 's').update(`${ts}.${body}`).digest('hex')}` } });
    await app.fusion.idle();
    const items = (await get<{ items: { id: string; ipGeo?: { lat: number }; geoFlags: { kind: string; distanceKm?: number }[]; meta: { asn?: string; asnOrg?: string } }[] }>(app, '/api/provenance?kind=ledger')).items;
    const e1 = items.find(i => i.id.endsWith(':e1'))!;
    expect(e1.ipGeo).toEqual({ lat: 1.336, lon: 103.7716 });
    expect(e1.geoFlags[0]).toMatchObject({ kind: 'ip-geo-mismatch' });
    expect(e1.geoFlags[0]!.distanceKm).toBeGreaterThan(7000);
    expect(e1.meta).toMatchObject({ asn: '721', asnOrg: 'DoD Network Information Center' });
    expect(items.find(i => i.id.endsWith(':e2'))!.geoFlags).toEqual([]);
  });
});

describe('gazetteer', () => {
  const GEONAMES = fileURLToPath(new URL('./fixtures/geonames-sample.txt', import.meta.url));

  it('GeoNames: resolves names in several scripts, respects the population floor and letter case', async () => {
    const r = new PlaceResolver({ fallback: [] });
    expect(await r.loadGeoNames(GEONAMES)).toBeGreaterThan(8);
    const names = (t: string) => r.fromText(t).map(p => p.name);
    expect(names('Explosion reported in Limassol this morning')).toEqual(['Limassol']);
    expect(names('דיווח על פיצוץ בנמל חיפה')).toEqual(['Haifa']);
    expect(names('انفجار في حيفا')).toEqual(['Haifa']);
    expect(names('Protest in downtown Los Angeles and in Nice')).toEqual(['Los Angeles', 'Nice']);
    // Ordinary lower-case words that are also towns are not place references.
    expect(names('a nice day for reading the report')).toEqual([]);
    // Below the population floor, and an airport code among the alternate names.
    expect(names('Fire near Kato Drys; flight from HFA delayed')).toEqual([]);
    const la = r.fromText('Los Angeles')[0]!;
    expect(la.bbox[2] - la.bbox[0]).toBeCloseTo(1, 5); // a metropolis gets the wider box
    expect(la.aliases).toEqual(['los angeles']);
    const missing = new PlaceResolver({ fallback: [] });
    expect(await missing.loadGeoNames('/nonexistent/cities.txt')).toBe(0);
    expect(missing.notes[0]).toContain('not found');
  });

  describe.each(backends)('Nominatim with a cache in the store on $name', backend => {
    it('asks once per place, caches hits and misses, and does not cache failures', async () => {
      let fail = false;
      const nom = await listen(url => {
        if (fail) return { status: 503, json: {} };
        const q = decodeURIComponent(/q=([^&]+)/.exec(url)![1]!);
        return { json: q.includes('zygi') ? [{ lat: '34.7289', lon: '33.3378', boundingbox: ['34.70', '34.75', '33.30', '33.37'], display_name: 'Zygi, Cyprus' }] : [] };
      });
      const app = await mk(backend, { env: { NOMINATIM_URL: nom.url, NOMINATIM_MIN_INTERVAL_MS: '0' } });
      const ingest = async (items: unknown[]) => {
        await post(app, '/api/ingest', { items });
        await app.fusion.idle();
      };
      await ingest([
        { text: 'Boat fire in the marina.', sourceType: 'feed', sourceId: 'a', grade: 'B2', claimedPlace: 'Zygi' },
        { text: 'Second report of the boat fire.', sourceType: 'feed', sourceId: 'b', grade: 'B2', claimedPlace: 'Zygi' },
        { text: 'Something in a place nobody has heard of.', sourceType: 'feed', sourceId: 'c', grade: 'B2', claimedPlace: 'Xyzzyville' },
        { text: 'Again from the place nobody has heard of.', sourceType: 'feed', sourceId: 'd', grade: 'B2', claimedPlace: 'Xyzzyville' },
        // A place the local gazetteer knows never goes to the network.
        { text: 'Crane collapse.', sourceType: 'feed', sourceId: 'e', grade: 'B2', claimedPlace: 'Limassol' },
      ]);
      expect(nom.hits.map(h => decodeURIComponent(/q=([^&]+)/.exec(h)![1]!)).sort()).toEqual(['xyzzyville', 'zygi']);
      const items = (await get<{ items: { sourceId: string; geo?: { lat: number; lon: number }; geoSource?: string }[] }>(app, '/api/provenance')).items;
      const a = items.find(i => i.sourceId === 'a')!;
      expect(a.geoSource).toBe('gazetteer');
      expect(a.geo!.lat).toBeCloseTo(34.725, 2);
      expect(items.find(i => i.sourceId === 'b')!.geo).toEqual(a.geo);
      expect(items.find(i => i.sourceId === 'c')!.geo).toBeUndefined();
      expect(await app.store.getGeocode('zygi')).toMatchObject({ hit: true, place: { name: 'Zygi' } });
      expect(await app.store.getGeocode('xyzzyville')).toEqual({ hit: true });

      fail = true;
      await ingest([{ text: 'Report from a third place.', sourceType: 'feed', sourceId: 'f', grade: 'B2', claimedPlace: 'Pissouri Bay' }]);
      expect(await app.store.getGeocode('pissouri bay')).toEqual({ hit: false });
      // Coordinates that contradict a Nominatim-resolved place are flagged like any other.
      fail = false;
      await ingest([{ text: 'Video of the marina fire.', sourceType: 'web', sourceId: 'g', grade: 'C3', claimedPlace: 'Zygi', geo: { lat: 48.85, lon: 2.35 } }]);
      const g = (await get<{ items: { sourceId: string; geoFlags: { kind: string; place?: string }[] }[] }>(app, '/api/provenance')).items.find(i => i.sourceId === 'g')!;
      expect(g.geoFlags[0]).toMatchObject({ kind: 'toponym-mismatch', place: 'Zygi' });
    });
  });
});

describe('live Telegram collector (driver stubbed, gate and pipeline real)', () => {
  const driver = fileURLToPath(new URL('./fixtures/fake-telegram-driver.mjs', import.meta.url));
  const setup = async (backend: (typeof backends)[number], messages: Record<string, unknown[]>, extra: Partial<AppOptions> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'ag-tg-'));
    const file = join(dir, 'tg.json');
    writeFileSync(file, JSON.stringify(messages));
    const app = await mk(backend, { dataDir: dir, env: { TELEGRAM_CHANNELS: 'harbour_watch:D3, port_news' }, telegram: { autoStart: false, env: { ...process.env, ADMIRALTY_TELEGRAM_DRIVER: driver, FAKE_TG_FILE: file } }, ...extra });
    return { app, file };
  };

  it('parses TELEGRAM_CHANNELS and rejects anything that is not a channel username', () => {
    expect(parseTelegramChannels('harbour_watch:d3, @port_news')).toEqual([{ channel: 'harbour_watch', grade: 'D3' }, { channel: 'port_news', grade: 'F6' }]);
    expect(parseTelegramChannels(undefined)).toEqual([]);
    expect(() => parseTelegramChannels('https://t.me/x')).toThrow(/not a public channel username/);
    expect(() => parseTelegramChannels('chan_ok:Z9')).toThrow(/Invalid Admiralty grade/);
  });

  it.each(backends)('polls through the gate, ingests messages as graded untrusted provenance and resumes from its cursor on $name', async backend => {
    const t = Date.UTC(2026, 10, 15, 8);
    const { app, file } = await setup(backend, {
      harbour_watch: [{ id: 10, text: 'Tugs idle at the east quay.', at: t }, { id: 11, text: 'Dock workers began a strike, union says.', at: t + 60_000, forwardedFrom: 'Wire_Forwards' }],
      port_news: [{ id: 5, text: 'Ferry schedule unchanged.', at: t }],
    });
    expect(await get<{ configured: boolean; channels: unknown[] }>(app, '/api/telegram/status')).toMatchObject({ configured: true, channels: [{ channel: 'harbour_watch', grade: 'D3' }, { channel: 'port_news', grade: 'F6' }] });
    expect((await post(app, '/api/telegram/poll')).json()).toEqual({ ingested: 3 });
    await app.fusion.idle();
    const items = (await get<{ items: { text: string; sourceType: string; sourceId: string; grade: string; owner: string; spanId?: string; at: number }[] }>(app, '/api/provenance')).items;
    expect(items.map(i => [i.sourceId, i.grade, i.owner, i.text]).sort()).toEqual([
      ['harbour_watch', 'D3', 'tg:harbour_watch', 'Tugs idle at the east quay.'],
      ['harbour_watch', 'D3', 'tg:wire_forwards', 'Dock workers began a strike, union says.'],
      ['port_news', 'F6', 'tg:port_news', 'Ferry schedule unchanged.'],
    ]);
    expect(items.every(i => i.sourceType === 'telegram' && /^s\d+$/.test(i.spanId ?? ''))).toBe(true);
    // Each poll is a gated tool call in the audit chain.
    const audit = await get<{ chainValid: boolean; entries: { data: { tool?: string; verdict?: string } }[] }>(app, '/api/audit');
    expect(audit.entries.filter(e => e.data.tool === 'telegram_poll' && e.data.verdict === 'allow')).toHaveLength(2);
    expect(audit.chainValid).toBe(true);

    // Nothing new: nothing ingested. Then one new message: only that one.
    expect((await post(app, '/api/telegram/poll')).json()).toEqual({ ingested: 0 });
    writeFileSync(file, JSON.stringify({ harbour_watch: [{ id: 10, text: 'old', at: t }, { id: 11, text: 'old', at: t }, { id: 12, text: 'Strike enters second day.', at: t + 86_400_000 }], port_news: [] }));
    expect((await post(app, '/api/telegram/poll')).json()).toEqual({ ingested: 1 });
    await app.fusion.idle();
    expect((await get<{ total: number }>(app, '/api/provenance')).total).toBe(4);
    expect(await app.store.getKv('telegram:cursor:harbour_watch')).toBe('12');
  });

  it('a channel that is not configured cannot be polled, whatever asks for it', async () => {
    const { app } = await setup(backends[0]!, { harbour_watch: [], secret_channel: [{ id: 1, text: 'private', at: 1 }] });
    const n = await app.telegram!.pollOnce('harbour_watch', { tool: 'telegram_poll', args: { channel: 'secret_channel', afterId: 0 } });
    expect(n).toBe(0);
    const st = await get<{ recentErrors: { channel: string; error: string }[] }>(app, '/api/telegram/status');
    expect(st.recentErrors[0]!.error).toContain('Blocked by admiralty-gate');
    await app.fusion.idle();
    expect((await get<{ total: number }>(app, '/api/provenance')).total).toBe(0);
    const audit = await get<{ entries: { data: { tool?: string; verdict?: string } }[] }>(app, '/api/audit');
    expect(audit.entries.filter(e => e.data.tool === 'telegram_poll').map(e => e.data.verdict)).toEqual(['deny']);
  });

  it('is off, and says so, when TELEGRAM_CHANNELS is not set', async () => {
    const app = await mk(backends[0]!);
    expect(await get<{ configured: boolean }>(app, '/api/telegram/status')).toMatchObject({ configured: false });
    expect((await post(app, '/api/telegram/poll')).statusCode).toBe(404);
  });
});

describe('default policy', () => {
  it('registers the OSIRIS collector tools under both spellings, and leaves probes and publishing gated', async () => {
    const app = await mk(backends[0]!);
    const p = (await get<{ policy: { tools: Record<string, { tier: string; targetArgs?: unknown }>; defaultTool?: unknown } }>(app, '/api/policy')).policy;
    for (const t of ['osint-fetch', 'osint_fetch']) expect(p.tools[t]).toMatchObject({ tier: 'lookup-infra' });
    for (const t of ['geo-enrich', 'geo_enrich', 'entity-graph', 'entity_graph']) expect(p.tools[t]).toEqual({ tier: 'lookup-person', targetArgs: '*' });
    expect(p.tools.port_scan!.tier).toBe('active-probe');
    expect(p.tools.send_alert!.tier).toBe('publish');
    // Still fail closed for anything unlisted.
    expect(p.defaultTool).toBeUndefined();
    const run = async (call: unknown) => {
      const id = ((await post(app, '/api/sandbox/run', { mode: 'simulated', custom: { operator: 'look at feeds.example.org', feed: 'x', call } })).json() as { runId: string }).runId;
      return (await app.runFinished(id)).outcome;
    };
    expect(await run({ tool: 'some_new_osiris_tool', args: { target: 'feeds.example.org' } })).toBe('BLOCK');
    expect(await run({ tool: 'osint_fetch', args: { url: 'feeds.example.org' } })).toBe('ALLOW');
  });
});
