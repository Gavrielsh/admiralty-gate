import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildApp, type App, type AppOptions } from '../src/app.js';
import { parseFeed, parseJsonl, parseTelegramExport } from '../src/collectors/parse.js';
import { parseCollectorConfig, runCollector } from '../src/collectors/runner.js';
import { cosine, hashEmbedding } from '../src/fusion/embed.js';
import { GeoIpTable } from '../src/fusion/geoip.js';
import { PgStore } from '../src/fusion/pgstore.js';
import { BullQueue } from '../src/fusion/queue.js';
import { MemoryStore } from '../src/fusion/store.js';
import type { Store } from '../src/fusion/types.js';

const PG = process.env.TEST_DATABASE_URL;
const REDIS = process.env.TEST_REDIS_URL;
const backends: { name: string; make: () => { store: Store; redisUrl?: string; queuePrefix?: string } }[] = [
  { name: 'memory store + in-process queue', make: () => ({ store: new MemoryStore() }) },
  ...(PG ? [{ name: `PostgreSQL (PostGIS + pgvector)${REDIS ? ' + BullMQ on Redis' : ''}`, make: () => ({ store: new PgStore(PG, `t_${randomBytes(6).toString('hex')}`), ...(REDIS ? { redisUrl: REDIS, queuePrefix: `t-${randomBytes(6).toString('hex')}` } : {}) }) }] : []),
];

const apps: App[] = [];
const pgStores: PgStore[] = [];
async function mk(backend: (typeof backends)[number], opts: Partial<AppOptions> = {}): Promise<App & { dir: string }> {
  const dir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'ag-fusion-'));
  const b = opts.store ? {} : backend.make();
  const app = await buildApp({ dataDir: dir, stepDelayMs: 0, env: {}, policyWatchMs: 0, ...b, ...opts });
  if (app.store instanceof PgStore) pgStores.push(app.store);
  apps.push(app);
  return { ...app, dir };
}
afterEach(async () => {
  for (const a of apps.splice(0)) {
    // A test may already have closed its app (the restart test does).
    try {
      await a.fusion.idle();
      if (a.queue instanceof BullQueue) await a.queue.obliterate();
    } catch {
      /* queue already closed */
    }
    await a.fastify.close();
  }
});
afterAll(async () => {
  // Remove the per-test schemas. Each needs its own connection because the app closed the store's pool.
  for (const s of pgStores) {
    const schema = (s as unknown as { schema: string }).schema;
    const admin = new PgStore(PG!, schema);
    await admin.dropSchema();
    await admin.close();
  }
});

const get = async <T>(app: App, url: string): Promise<T> => {
  const r = await app.fastify.inject({ url });
  expect(r.statusCode, `${url} -> ${r.body}`).toBe(200);
  return r.json() as T;
};
const post = (app: App, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.fastify.inject({ method: 'POST', url, ...(payload === undefined ? {} : { payload: payload as object }), headers });
const demo = async (app: App) => {
  const r = await post(app, '/api/fusion/demo');
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { loaded: number; items: number; claims: string[] };
};

interface Feature { geometry: { type: string; coordinates: number[] | number[][] }; properties: Record<string, unknown> }
interface FC { features: Feature[]; meta: Record<string, unknown> }
const points = (fc: FC) => fc.features.filter(f => f.geometry.type === 'Point');
const byId = (fc: FC, id: string) => points(fc).find(f => f.properties.id === id)!;

describe.each(backends)('fusion on $name', backend => {
  it('reports which store and queue are in use', async () => {
    const app = await mk(backend);
    const s = await get<{ store: string; queue: string }>(app, '/api/fusion/status');
    expect(s.store).toBe(app.store.kind);
    expect(s.queue).toBe(backend.name.includes('BullMQ') ? 'bullmq' : 'inline');
  });

  it('ingests graded items as untrusted provenance, grades the ungraded F6, and de-duplicates', async () => {
    const app = await mk(backend);
    const items = [
      { text: 'Dock workers at Limassol port began an indefinite strike on Monday.', sourceType: 'feed', sourceId: 'wire', grade: 'b2', claim: 'strike' },
      { text: 'Anonymous tip: the strike is fake.', sourceType: 'telegram', sourceId: 'anon-chan', claim: 'strike', stance: 'contradicts' },
    ];
    const r = await post(app, '/api/ingest', { items });
    expect(r.statusCode).toBe(202);
    const { ids } = r.json() as { ids: string[] };
    await app.fusion.idle();
    // Same content again: accepted by the API, dropped by the pipeline.
    await post(app, '/api/ingest', { items });
    await app.fusion.idle();

    const p = await get<{ items: { id: string; grade: string; spanId?: string; geo?: unknown; geoSource?: string; stance?: string }[]; total: number; claims: string[] }>(app, '/api/provenance');
    expect(p.total).toBe(2);
    expect(p.claims).toEqual(['strike']);
    expect(p.items.map(i => i.id).sort()).toEqual([...ids].sort());
    const wire = p.items.find(i => i.id === ids[0])!;
    expect(wire.grade).toBe('B2');
    expect(wire.spanId).toMatch(/^s\d+$/);
    expect(wire.geoSource).toBe('gazetteer');
    expect(p.items.find(i => i.id === ids[1])!.grade).toBe('F6');

    // The ledger holds both as UNTRUSTED: a report repeating the wire is grounded in it, never "operator".
    const g = (await post(app, '/api/grounding', { report: 'Dock workers at Limassol port began an indefinite strike on Monday.', sources: [], useLedger: true })).json() as { sentences: { level: string; bestGrade?: string; support: { origin: { id: string } }[] }[]; sources: { trusted: boolean }[] };
    expect(g.sentences[0]).toMatchObject({ level: 'single', bestGrade: 'B2' });
    expect(g.sentences[0]!.support[0]!.origin.id).toBe('wire');
    expect(g.sources.every(s => s.trusted === false)).toBe(true);
    expect(app.bus.since().filter(e => e.type === 'fusion.ingested')).toHaveLength(2);
    expect(app.bus.since().filter(e => e.type === 'fusion.duplicate')).toHaveLength(2);
  });

  it('rejects malformed items with the reason and stores nothing', async () => {
    const app = await mk(backend);
    for (const [bad, msg] of [
      [{ items: [{ text: 'x', sourceType: 'carrier-pigeon', sourceId: 'a' }] }, 'sourceType must be one of'],
      [{ items: [{ text: '', sourceType: 'feed', sourceId: 'a' }] }, 'text must be a non-empty string'],
      [{ items: [{ text: 'x', sourceType: 'feed', sourceId: 'a', grade: 'Z9' }] }, 'Invalid Admiralty grade'],
      [{ items: [{ text: 'x', sourceType: 'feed', sourceId: 'a', geo: { lat: 99, lon: 0 } }] }, 'geo must be'],
      [{ items: [{ text: 'x', sourceType: 'feed', sourceId: 'a', indicators: [{ kind: 'shoe-size', value: '44' }] }] }, 'indicators[0] must be'],
      [{ items: [{ text: 'x', sourceType: 'feed', sourceId: 'a', stance: 'maybe' }] }, 'stance must be'],
      [{ nope: 1 }, 'body must be'],
    ] as const) {
      const r = await post(app, '/api/ingest', bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
      expect(r.body).toContain(msg);
    }
    await app.fusion.idle();
    expect((await get<{ total: number }>(app, '/api/provenance')).total).toBe(0);
  });

  it('demo scenario: releases the corroborated claim, quarantines the manufactured one, finds the rings', async () => {
    const app = await mk(backend);
    const d = await demo(app);
    expect(d.claims).toEqual(['haifa-refinery-explosion', 'limassol-port-strike', 'red-sea-vessel-incident']);
    // Idempotent: loading again adds nothing.
    expect((await demo(app)).items).toBe(d.items);

    const fc = await get<FC>(app, '/api/geo/incidents');
    const strike = byId(fc, 'claim:limassol-port-strike').properties;
    expect(strike).toMatchObject({ status: 'released', released: true, independentSupport: 2, rawItems: 7, bestGrade: 'A2' });
    expect(strike.confidence as number).toBeGreaterThan(0.9);
    const sp = byId(fc, 'claim:limassol-port-strike').geometry.coordinates as number[];
    expect(sp[0]).toBeGreaterThan(32.9);
    expect(sp[0]).toBeLessThan(33.2);

    const rumour = byId(fc, 'claim:haifa-refinery-explosion').properties;
    expect(rumour).toMatchObject({ status: 'quarantined', released: false, independentSupport: 1, rawItems: 7 });
    expect(rumour.flags).toEqual(expect.arrayContaining(['echo-chamber', 'coordinated', 'geo-mismatch', 'single-source']));
    expect((rumour.reasons as string[]).join(' ')).toMatch(/coordinates that contradict/);
    // It is drawn at Haifa (from the place name), not at the bogus coordinates one channel attached.
    const rp = byId(fc, 'claim:haifa-refinery-explosion').geometry.coordinates as number[];
    expect(rp[0]).toBeGreaterThan(34.8);
    expect(rp[0]).toBeLessThan(35.2);

    expect(byId(fc, 'claim:red-sea-vessel-incident').properties).toMatchObject({ status: 'quarantined', independentSupport: 1 });

    const rings = points(fc).filter(f => f.properties.kind === 'ring').map(f => f.properties).sort((a, b) => (b.rawItems as number) - (a.rawItems as number));
    expect(rings.map(r => r.rawItems)).toEqual([7, 4]);
    expect(rings.every(r => r.status === 'ring' && r.released === false)).toBe(true);
    expect(rings[0]!.title).toBe('7 accounts linked by 5 shared indicator(s)');
    expect(rings[0]!.flags).toEqual(['3 event(s) through a proxy or VPN', '3 event(s) with a location mismatch']);
    // The two accounts sharing one device stay below the ring threshold.
    expect(JSON.stringify(rings)).not.toContain('fp-0c0c');
    // Entity-cluster links are lines between ring members.
    const lines = fc.features.filter(f => f.geometry.type === 'LineString');
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.every(l => l.properties.kind === 'link')).toBe(true);
    expect(fc.meta).toMatchObject({ incidents: 5, located: 5, store: app.store.kind });
  });

  it('filters incidents by release status, grade, kind, bounding box and time window', async () => {
    const app = await mk(backend);
    await demo(app);
    const ids = async (qs: string) => points(await get<FC>(app, `/api/geo/incidents?${qs}`)).map(f => f.properties.id as string).sort();
    expect(await ids('released=true')).toEqual(['claim:limassol-port-strike']);
    expect((await ids('released=false')).length).toBe(4);
    expect(await ids('kind=claim&minGrade=B2')).toEqual(['claim:limassol-port-strike', 'claim:red-sea-vessel-incident']);
    expect(await ids('kind=claim&minGrade=A2')).toEqual(['claim:limassol-port-strike']);
    expect((await ids('kind=ring')).every(i => i.startsWith('ring:'))).toBe(true);
    // Around Haifa only.
    expect(await ids('bbox=34.5,32.4,35.5,33.2')).toEqual(['claim:haifa-refinery-explosion']);
    // The southern Red Sea.
    expect(await ids('bbox=40,12,45,17')).toEqual(['claim:red-sea-vessel-incident']);
    const now = Date.now();
    expect(await ids(`kind=claim&since=${now - 60 * 60_000}`)).toEqual(['claim:red-sea-vessel-incident']);
    expect(await ids(`kind=claim&until=${now - 120 * 60_000}`)).toEqual(['claim:limassol-port-strike']);
    expect(await ids(`kind=claim&since=${new Date(now + 60_000).toISOString()}`)).toEqual([]);
    for (const bad of ['released=yes', 'minGrade=Z9', 'bbox=1,2,3', 'since=tomorrow', 'kind=rumour'])
      expect((await app.fastify.inject({ url: `/api/geo/incidents?${bad}` })).statusCode, bad).toBe(400);
  });

  it('heatmap bins located events on a grid and filters by proxy flag and area', async () => {
    const app = await mk(backend);
    await demo(app);
    const all = await get<FC>(app, '/api/geo/heatmap?kind=ledger&cell=0.1');
    expect(all.meta).toMatchObject({ events: 19, cell: 0.1 });
    expect(points(all).reduce((a, f) => a + (f.properties.count as number), 0)).toBe(19);
    // Cells are sorted by weight and snapped to the grid.
    const counts = points(all).map(f => f.properties.count as number);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    for (const f of points(all)) for (const c of f.geometry.coordinates as number[]) expect(Math.abs(c * 10 - Math.round(c * 10))).toBeLessThan(1e-6);
    expect((await get<FC>(app, '/api/geo/heatmap?kind=ledger&proxy=true')).meta.events).toBe(4);
    // Paphos district only: ring B and one ordinary event.
    expect((await get<FC>(app, '/api/geo/heatmap?kind=ledger&bbox=32.2,34.6,32.6,34.9')).meta.events).toBe(5);
    expect((await get<FC>(app, '/api/geo/heatmap?cell=1')).meta.events as number).toBeGreaterThan(19);
    expect((await app.fastify.inject({ url: '/api/geo/heatmap?cell=0' })).statusCode).toBe(400);
  });

  it('/api/corroborate returns clusters, noisy-OR, echo reduction and the release decision', async () => {
    const app = await mk(backend);
    await demo(app);
    type V = { rawSources: number; independentClusters: number; noisyOr: { support: number; confidence: number; contradiction: number }; echoReduction: number; release: { allowed: boolean; reasons: string[] }; gradeDistribution: Record<string, number>; members: { cluster: string }[]; assessment: { flags: string[] } };
    const strike = (await post(app, '/api/corroborate', { claim: 'limassol-port-strike' })).json() as V;
    expect(strike).toMatchObject({ rawSources: 7, independentClusters: 2, release: { allowed: true, reasons: [] }, gradeDistribution: { A2: 1, B2: 1, D3: 5 } });
    expect(strike.noisyOr.support).toBeCloseTo(1 - (1 - 0.81) * (1 - 0.675), 5);
    expect(strike.echoReduction).toBeCloseTo(1 - 2 / 7, 5);
    expect(new Set(strike.members.map(m => m.cluster)).size).toBe(2);

    const rumour = (await post(app, '/api/corroborate', { claim: 'haifa-refinery-explosion' })).json() as V;
    expect(rumour.release.allowed).toBe(false);
    expect(rumour.independentClusters).toBe(2); // the network (one cluster) and the fire service that contradicts it
    expect(rumour.noisyOr.contradiction).toBeCloseTo(0.81, 5);
    expect(rumour.echoReduction).toBeCloseTo(1 - 1 / 6, 5);

    // Without indicator and burst linking the same network looks like six independent sources: the false confidence.
    const naive = (await post(app, '/api/corroborate', { claim: 'haifa-refinery-explosion', options: { indicators: false, burstWindowMs: null } })).json() as V;
    expect(naive.independentClusters).toBe(7);
    expect(naive.echoReduction).toBe(0);
    // A stricter rule holds the strike back too.
    const strict = (await post(app, '/api/corroborate', { claim: 'limassol-port-strike', options: { rule: { minIndependentSupport: 3 } } })).json() as V;
    expect(strict.release).toEqual({ allowed: false, reasons: ['needs 3 independent supporting origins, has 2'] });

    // Ad-hoc evidence, nothing stored.
    const adhoc = (await post(app, '/api/corroborate', { claim: 'x', evidence: [
      { text: 'Bridge closed after collision, police say.', sourceType: 'feed', sourceId: 'wire', grade: 'B2' },
      { text: 'Transport ministry confirms the bridge is shut.', sourceType: 'web', sourceId: 'ministry', grade: 'A2' },
    ] })).json() as V;
    expect(adhoc).toMatchObject({ rawSources: 2, independentClusters: 2, release: { allowed: true } });

    expect((await post(app, '/api/corroborate', { claim: 'no-such-claim' })).statusCode).toBe(404);
    for (const bad of [{}, { claim: 'x', evidence: [] }, { claim: 'x', options: { burstWindowMs: -5 } }, { claim: 'x', options: { rule: { minConfidence: 'high' } } }])
      expect((await post(app, '/api/corroborate', bad)).statusCode, JSON.stringify(bad)).toBe(400);
  });

  it('/api/provenance filters by indicator, grade and area, ranks by text similarity and returns entity links', async () => {
    const app = await mk(backend);
    await demo(app);
    type P = { items: { id: string; sourceId: string; kind: string; grade: string }[]; entityLinks: { indicator: string; itemIds: string[]; structural: boolean }[] };
    const hub = await get<P>(app, '/api/provenance?indicator=telegram:Amplifier_Hub');
    expect(hub.items.map(i => i.sourceId).sort()).toEqual([1, 2, 3, 4, 5, 6].map(i => `amp-channel-${i}`));
    expect(hub.entityLinks[0]).toMatchObject({ indicator: 'telegram:amplifier_hub', structural: true });
    expect(hub.entityLinks[0]!.itemIds).toHaveLength(6);
    // An indicator that is only mentioned in text is found too.
    expect((await get<P>(app, '/api/provenance?indicator=ip:203.0.113.9')).items.map(i => i.sourceId)).toEqual(['cert-advisory']);
    expect((await get<P>(app, '/api/provenance?kind=osint&minGrade=A2')).items.map(i => i.sourceId).sort()).toEqual(['cert-advisory', 'fire-service.example', 'ports-authority.example']);
    expect((await get<P>(app, '/api/provenance?kind=ledger&limit=2000')).items).toHaveLength(19);
    expect((await get<P>(app, '/api/provenance?kind=osint&bbox=40,12,45,17')).items.map(i => i.sourceId)).toEqual(['maritime-bulletin']);
    const near = await get<P>(app, '/api/provenance?kind=osint&limit=3&q=' + encodeURIComponent('phishing panel shady-pay login advisory'));
    expect(near.items[0]!.sourceId).toBe('cert-advisory');
    expect((await app.fastify.inject({ url: '/api/provenance?indicator=nocolon' })).statusCode).toBe(400);
    expect((await app.fastify.inject({ url: '/api/provenance?limit=0' })).statusCode).toBe(400);
  });

  it('keeps a database mirror of the audit chain and restores provenance into the ledger after a restart', async () => {
    const first = await mk(backend);
    await demo(first);
    await post(first, '/api/sandbox/run', { mode: 'simulated', scenarioId: 'injection-plain' }).then(r => first.runFinished((r.json() as { runId: string }).runId));
    const a = await get<{ chainValid: boolean; entries: unknown[]; mirror: { store: string; count: number; inSync: boolean } }>(first, '/api/audit');
    expect(a.chainValid).toBe(true);
    expect(a.mirror).toMatchObject({ store: first.store.kind, count: a.entries.length, inSync: true });
    if (first.store.kind !== 'postgres') return;

    // Same database, new process: items, incidents and the ledger come back.
    const schema = (first.store as unknown as { schema: string }).schema;
    if (first.queue instanceof BullQueue) await first.queue.obliterate();
    await first.fastify.close();
    const second = await mk(backend, { dataDir: first.dir, store: new PgStore(PG!, schema) });
    expect((await get<{ total: number }>(second, '/api/provenance')).total).toBe(35);
    expect(points(await get<FC>(second, '/api/geo/incidents?released=true')).map(f => f.properties.id)).toEqual(['claim:limassol-port-strike']);
    const g = (await post(second, '/api/grounding', { report: 'Cyprus ports authority confirms cargo handling at Limassol is suspended.', sources: [], useLedger: true })).json() as { sentences: { level: string; bestGrade?: string }[] };
    expect(g.sentences[0]).toMatchObject({ level: 'single', bestGrade: 'A2' });
    expect((await get<{ mirror: { inSync: boolean } }>(second, '/api/audit')).mirror.inSync).toBe(true);
  });
});

describe('ACH endpoint', () => {
  const body = {
    hypotheses: [{ id: 'h1', label: 'Ring operated from Cyprus' }, { id: 'h2', label: 'Compromised accounts, operator abroad' }],
    evidence: [
      { id: 'e1', label: 'Devices seen at ATMs in person', grade: 'B2' },
      { id: 'e2', label: 'Logins through a VPN exit', grade: 'B2' },
      { id: 'e3', label: 'Anonymous claim of responsibility', grade: 'E4' },
    ],
    cells: { e1: { h1: 2, h2: -2 }, e2: { h1: 0, h2: 1 }, e3: { h1: -1, h2: 1 } },
  };

  it('ranks hypotheses, marks critical evidence and gates the attribution', async () => {
    const app = await mk(backends[0]!);
    const r = (await post(app, '/api/ach', body)).json() as { result: { leader: string; margin: number; critical: { id: string }[]; nonDiagnostic: string[] }; attribution: { allowed: boolean; reasons: string[]; leader: string } };
    expect(r.result.leader).toBe('h1');
    expect(r.result.critical.map(c => c.id)).toEqual(['e1']);
    expect(r.attribution).toMatchObject({ allowed: true, leader: 'h1' });

    // Take the one strong item away: the conclusion now rests on an E4 rumour and is held back.
    const weak = (await post(app, '/api/ach', { ...body, evidence: body.evidence.filter(e => e.id !== 'e1'), cells: { e2: body.cells.e2, e3: body.cells.e3 } })).json() as typeof r;
    expect(weak.result.leader).toBe('h2');
    expect(weak.attribution.allowed).toBe(false);
    expect(weak.attribution.reasons.join(' | ')).toMatch(/lead over the next hypothesis/);

    const strict = (await post(app, '/api/ach', { ...body, rule: { minMargin: 5 } })).json() as typeof r;
    expect(strict.attribution.allowed).toBe(false);
  });

  it('rejects off-scale cells and malformed matrices', async () => {
    const app = await mk(backends[0]!);
    for (const [bad, msg] of [
      [{ ...body, cells: { e1: { h1: 3 } } }, 'must be -2, -1, 0, 1 or 2'],
      [{ ...body, cells: { e1: { h9: 1 } } }, 'unknown hypothesis "h9"'],
      [{ ...body, evidence: [{ id: 'e1', label: 'x', grade: 'Q7' }] }, 'must be an Admiralty grade'],
      [{ ...body, hypotheses: [] }, 'at least one hypothesis'],
      [{ ...body, hypotheses: [{ id: 'h1', label: 'a' }, { id: 'h1', label: 'b' }] }, 'ids must be unique'],
      [{ hypotheses: [] }, 'body must be'],
    ] as const) {
      const r = await post(app, '/api/ach', bad);
      expect(r.statusCode).toBe(400);
      expect((r.json() as { error: string }).error).toContain(msg);
    }
  });
});

describe('ledger anomaly webhook', () => {
  const secret = 'test-secret';
  const sign = (body: string, ts = Date.now(), key = secret) => ({ 'content-type': 'application/json', 'x-admiralty-timestamp': String(ts), 'x-admiralty-signature': `sha256=${createHmac('sha256', key).update(`${ts}.${body}`).digest('hex')}` });
  const send = (app: App, body: string, headers: Record<string, string>) => app.fastify.inject({ method: 'POST', url: '/api/ingest/ledger', payload: body, headers });
  const events = [0, 1, 2].map(i => ({ id: `e${i}`, account: `acct-${i}`, wallet: '0x' + 'ab'.repeat(20), ip: `203.0.113.${5 + i}`, asn: '64500', proxy: i === 2, amount: 100, lat: 34.68, lon: 33.04, at: Date.now() - i * 1000 }));

  it('is disabled without a secret', async () => {
    const app = await mk(backends[0]!);
    expect((await send(app, '{}', sign('{}'))).statusCode).toBe(503);
  });

  it('accepts only correctly signed, fresh requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag-geoip-'));
    writeFileSync(join(dir, 'geoip.csv'), '# cidr,lat,lon\n203.0.113.0/24,50.11,8.68,vpn\n203.0.113.5/32,34.70,33.00,local\n');
    const app = await mk(backends[0]!, { env: { LEDGER_WEBHOOK_SECRET: secret, GEOIP_CSV: join(dir, 'geoip.csv') } });
    const body = JSON.stringify({ events });
    expect((await send(app, body, { 'content-type': 'application/json' })).statusCode).toBe(401);
    expect((await send(app, body, sign(body, Date.now(), 'wrong-secret'))).statusCode).toBe(401);
    expect((await send(app, body, sign(body, Date.now() - 10 * 60_000))).statusCode).toBe(401);
    // Signed for a different body.
    expect((await send(app, body, sign(body + ' '))).statusCode).toBe(401);
    await app.fusion.idle();
    expect((await get<{ total: number }>(app, '/api/provenance')).total).toBe(0);

    const ok = await send(app, body, sign(body));
    expect(ok.statusCode).toBe(202);
    await app.fusion.idle();
    const p = await get<{ items: { id: string; kind: string; grade: string; sourceId: string; indicators: { kind: string }[]; geoFlags: { kind: string }[]; ipGeo?: { lat: number } }[] }>(app, '/api/provenance?kind=ledger');
    expect(p.items).toHaveLength(3);
    expect(p.items.every(i => i.grade === 'B2' && i.sourceId.startsWith('account:'))).toBe(true);
    const e = (id: string) => p.items.find(i => i.id.endsWith(`:${id}`))!;
    // Longest prefix wins: .5 resolves locally (no flag); .6 resolves to the VPN range, far from the claimed position.
    expect(e('e0').geoFlags).toEqual([]);
    expect(e('e1').geoFlags.map(f => f.kind)).toEqual(['ip-geo-mismatch']);
    // A proxy address is kept as information but not used to link accounts.
    expect(e('e2').indicators.map(i => i.kind)).toEqual(['wallet']);
    expect(e('e0').indicators.map(i => i.kind).sort()).toEqual(['ip', 'wallet']);
    // Three accounts, one wallet: a ring.
    const fc = await get<FC>(app, '/api/geo/incidents?kind=ring');
    expect(points(fc)).toHaveLength(1);
    expect(points(fc)[0]!.properties.title).toBe('3 accounts linked by 1 shared indicator(s)');

    const bad = JSON.stringify({ events: [{ id: 'x', account: 'a', ip: 'not-an-ip' }] });
    const r = await send(app, bad, sign(bad));
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('ip is not an IPv4 address');
  });
});

describe('collectors through the MCP gate proxy', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());
  const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Ports</title>
    <item><title>Strike at Limassol port &amp; delays</title><description><![CDATA[Cargo <b>handling</b> suspended.]]></description><guid>g-1</guid><pubDate>Sun, 15 Nov 2026 08:00:00 GMT</pubDate><link>https://feeds.example.org/1</link></item>
    <item><title>Second headline</title><guid>g-2</guid></item><item><title></title></item></channel></rss>`;
  const serveFeed = async (): Promise<string> => {
    server = createServer((req, res) => (req.url === '/ports.xml' ? res.end(FEED) : (res.writeHead(404), res.end())));
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/ports.xml`;
  };

  it('collects a configured feed, grades it from the config, and ingests it as untrusted provenance', async () => {
    const url = await serveFeed();
    const app = await mk(backends[0]!);
    writeFileSync(join(app.dir, 'collectors.json'), JSON.stringify({ sources: [{ id: 'ports-feed', type: 'feed', location: url, grade: 'B2', claim: 'strike' }] }));
    expect((await get<{ sources: { id: string }[] }>(app, '/api/collectors')).sources.map(s => s.id)).toEqual(['ports-feed']);
    const r = await post(app, '/api/collectors/run', { id: 'ports-feed' });
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({ verdict: 'allow', accepted: 2 });
    await app.fusion.idle();
    const p = await get<{ items: { text: string; grade: string; sourceType: string; sourceId: string; claim: string; at: number; id: string }[] }>(app, '/api/provenance');
    expect(p.items.map(i => i.text).sort()).toEqual(['Second headline', 'Strike at Limassol port & delays. Cargo handling suspended.']);
    expect(p.items.every(i => i.grade === 'B2' && i.sourceType === 'feed' && i.sourceId === 'ports-feed' && i.claim === 'strike')).toBe(true);
    expect(p.items.find(i => i.id.endsWith(':g-1'))!.at).toBe(Date.parse('2026-11-15T08:00:00Z'));
    // The gate's decision for the collection run is in the audit chain.
    const audit = await get<{ entries: { kind: string; data: { tool?: string; verdict?: string } }[]; chainValid: boolean }>(app, '/api/audit');
    expect(audit.entries.some(e => e.data.tool === 'collect_feed' && e.data.verdict === 'allow')).toBe(true);
    expect(audit.chainValid).toBe(true);
    expect((await post(app, '/api/collectors/run', { id: 'nope' })).statusCode).toBe(404);
  });

  it('refuses a location the operator did not configure: the collector never sees the call', async () => {
    const url = await serveFeed();
    const src = { id: 'ports-feed', type: 'feed' as const, location: url, grade: 'B2' };
    const other = await runCollector(src, { call: { tool: 'collect_feed', args: { url: url.replace('ports.xml', 'secret.xml') } } });
    expect(other.decision.verdict).toBe('deny');
    expect(other.items).toEqual([]);
    expect(other.error).toContain('Blocked by admiralty-gate');
    const file = await runCollector(src, { call: { tool: 'collect_jsonl', args: { path: '/etc/passwd' } } });
    expect(file.decision.verdict).toBe('deny');
    const unknown = await runCollector(src, { call: { tool: 'run_shell', args: { cmd: 'id' } } });
    expect(unknown.decision).toMatchObject({ verdict: 'deny', tier: 'unregistered' });
    // And a source that fails is an error, not an empty success.
    const dead = await runCollector({ ...src, location: 'http://127.0.0.1:9/none.xml' });
    expect(dead.decision.verdict).toBe('allow');
    expect(dead.error).toContain('collector error');
  });

  it('reads a Telegram export and attributes forwards to the channel they came from', async () => {
    const app = await mk(backends[0]!);
    const exp = join(app.dir, 'result.json');
    writeFileSync(exp, JSON.stringify({ name: 'Harbour Watch', type: 'public_channel', id: 1, messages: [
      { id: 1, type: 'message', date_unixtime: '1794650000', text: 'Own report: tugs idle at the east quay.' },
      { id: 2, type: 'message', date_unixtime: '1794650100', forwarded_from: 'Wire Forwards', text: ['Dock workers began a strike, ', { type: 'bold', text: 'union says' }, '.'] },
      { id: 3, type: 'service', action: 'pin_message' }, { id: 4, type: 'message', text: '' },
    ] }));
    writeFileSync(join(app.dir, 'collectors.json'), JSON.stringify({ sources: [{ id: 'harbour-watch', type: 'telegram-export', location: exp, grade: 'D3' }] }));
    const r = await post(app, '/api/collectors/run', { id: 'harbour-watch' });
    expect(r.json()).toMatchObject({ verdict: 'allow', accepted: 2 });
    await app.fusion.idle();
    const p = await get<{ items: { text: string; owner: string; sourceType: string; at: number }[] }>(app, '/api/provenance');
    expect(p.items.map(i => [i.text, i.owner, i.sourceType])).toEqual([
      ['Dock workers began a strike, union says.', 'tg:wire forwards', 'telegram'],
      ['Own report: tugs idle at the east quay.', 'tg:harbour watch', 'telegram'],
    ]);
    expect(p.items[0]!.at).toBe(1794650100000);
  });

  it('validates the collector configuration strictly', () => {
    expect(parseCollectorConfig({ sources: [{ id: 'a', type: 'jsonl', location: '/x.jsonl' }] })[0]).toMatchObject({ grade: 'F6' });
    for (const [bad, msg] of [
      [{ sources: [{ id: 'a', type: 'ftp', location: 'x' }] }, 'type must be one of'],
      [{ sources: [{ id: 'a', type: 'feed', location: 'x', grade: 'Z1' }] }, 'grade:'],
      [{ sources: [{ id: 'a', type: 'feed', location: 'x', trust: true }] }, 'unknown key "trust"'],
      [{ sources: [{ id: 'a', type: 'feed', location: 'x' }, { id: 'a', type: 'feed', location: 'y' }] }, 'duplicate source id'],
      [{ sources: [{ id: 'bad id!', type: 'feed', location: 'x' }] }, 'id must be'],
      [[], 'top level'],
    ] as const) expect(() => parseCollectorConfig(bad), msg).toThrow(msg);
  });
});

describe('policy hot reload', () => {
  it('applies a valid edit made to policy.json on disk and rejects an invalid one, keeping the running policy', async () => {
    const app = await mk(backends[0]!);
    const file = join(app.dir, 'policy.json');
    const run = async () => {
      const r = await post(app, '/api/sandbox/run', { mode: 'simulated', scenarioId: 'authorised-probe' });
      return (await app.runFinished((r.json() as { runId: string }).runId)).outcome;
    };
    expect(await run()).toBe('ALLOW');
    const policy = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...policy, authorisedTargets: [] }));
    app.reloadPolicy();
    expect(await run()).toBe('BLOCK');
    expect(app.bus.since().some(e => e.type === 'policy.updated' && (e.data as { source: string }).source === 'file')).toBe(true);

    writeFileSync(file, JSON.stringify({ ...policy, allowEverything: true }));
    app.reloadPolicy();
    const rejected = app.bus.since().filter(e => e.type === 'policy.rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.data as { error: string }).error).toContain('unknown key "allowEverything"');
    expect(await run()).toBe('BLOCK');
    writeFileSync(file, '{ not json');
    app.reloadPolicy();
    expect(app.bus.since().filter(e => e.type === 'policy.rejected')).toHaveLength(2);
    const audit = await get<{ entries: { kind: string; data: { source?: string } }[]; chainValid: boolean }>(app, '/api/audit');
    expect(audit.entries.filter(e => e.kind === 'policy.updated' && e.data.source === 'file')).toHaveLength(1);
    expect(audit.chainValid).toBe(true);
  });

  it('the file watcher picks up an edit by itself', async () => {
    const app = await mk(backends[0]!, { policyWatchMs: 50 });
    const file = join(app.dir, 'policy.json');
    const policy = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    await new Promise(r => setTimeout(r, 1100)); // mtime granularity
    writeFileSync(file, JSON.stringify({ ...policy, authorisedTargets: ['other.example'] }));
    for (let i = 0; i < 60 && !app.bus.since().some(e => e.type === 'policy.updated'); i++) await new Promise(r => setTimeout(r, 50));
    expect(((await get<{ policy: { authorisedTargets: string[] } }>(app, '/api/policy')).policy).authorisedTargets).toEqual(['other.example']);
  });
});

describe('small pure pieces', () => {
  it('hash embedding: normalised, deterministic, close for similar spelling', () => {
    const a = hashEmbedding('Dock workers at Limassol port began a strike');
    expect(a).toHaveLength(256);
    expect(Math.hypot(...a)).toBeCloseTo(1, 6);
    expect(hashEmbedding('Dock workers at Limassol port began a strike')).toEqual(a);
    const near = cosine(a, hashEmbedding('dock worker at Limassol ports begins strike'));
    const far = cosine(a, hashEmbedding('Quarterly earnings beat analyst expectations'));
    expect(near).toBeGreaterThan(0.6);
    expect(far).toBeLessThan(0.3);
    expect(hashEmbedding('')).toEqual(new Array(256).fill(0));
  });

  it('GeoIP table: longest prefix, bad rows skipped, unknown addresses unresolved', () => {
    const t = new GeoIpTable();
    expect(t.load('# comment\n198.51.100.0/24,34.68,33.04\n198.51.100.128/25,35.17,33.36\n0.0.0.0/0,0,0\nbad,row\n300.1.1.1/8,1,1\n')).toBe(3);
    expect(t.lookup('198.51.100.7')).toEqual({ lat: 34.68, lon: 33.04 });
    expect(t.lookup('198.51.100.200')).toEqual({ lat: 35.17, lon: 33.36 });
    expect(t.lookup('8.8.8.8')).toEqual({ lat: 0, lon: 0 });
    expect(t.lookup('not-an-ip')).toBeUndefined();
    expect(new GeoIpTable().lookup('198.51.100.7')).toBeUndefined();
  });

  it('feed, Atom and JSONL parsers', () => {
    const atom = '<feed><entry><title>Atom &lt;one&gt;</title><summary>Sum &#8212; mary</summary><id>urn:1</id><updated>2026-11-15T08:00:00Z</updated><link href="https://a.example/1"/></entry></feed>';
    expect(parseFeed(atom)).toEqual([{ text: 'Atom <one>. Sum — mary', externalId: 'urn:1', at: Date.parse('2026-11-15T08:00:00Z'), meta: { link: 'https://a.example/1' } }]);
    expect(parseFeed('not xml at all')).toEqual([]);
    expect(parseJsonl('{"id":7,"summary":"scan done","lat":34.6,"lng":33.0,"place":"Limassol","claim":"c1","stance":"contradicts"}\nnot json\n{"no":"text"}\n')).toEqual([
      { text: 'scan done', externalId: '7', claim: 'c1', stance: 'contradicts', claimedPlace: 'Limassol', geo: { lat: 34.6, lon: 33.0 } },
    ]);
    expect(parseTelegramExport('{"name":"X","messages":[]}')).toEqual([]);
  });
});
