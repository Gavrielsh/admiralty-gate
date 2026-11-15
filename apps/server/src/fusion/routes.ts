import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  ach, attributionGate, DEFAULT_ATTRIBUTION_RULE, gradeString, normaliseIndicator, parseGrade,
  type AchInput, type AuditLog, type Cell, type Evidence, type IndicatorKind,
} from 'admiralty-gate';
import { parseCollectorConfig, runCollector, type CollectorSource } from '../collectors/runner.js';
import { DEMO_GEOIP, demoItems, demoLedger } from './demo.js';
import type { EmbeddingProvider } from './embedding.js';
import type { IpResolver, PlaceResolver } from './georesolve.js';
import { FusionService, ValidationError, ledgerToRaw, parseLedgerEvent, parseRawItem, type CorroborateRequest, type RawItem } from './service.js';
import type { BBox, Incident, Store } from './types.js';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface FusionRouteContext {
  fusion: FusionService;
  store: Store;
  audit: AuditLog;
  ips: IpResolver;
  places: PlaceResolver;
  embedding: EmbeddingProvider;
  embeddingDegraded?: string;
  env: Record<string, string | undefined>;
  collectorsFile: string;
  queueKind: string;
}

class BadRequest extends Error {}

function qTime(v: unknown, name: string): number | undefined {
  if (v === undefined || v === '') return undefined;
  const s = String(v);
  const t = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  if (!Number.isFinite(t)) throw new BadRequest(`${name} must be epoch milliseconds or an ISO date`);
  return t;
}
function qBBox(v: unknown): BBox | undefined {
  if (v === undefined || v === '') return undefined;
  const p = String(v).split(',').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isFinite(n)) || p[0]! > p[2]! || p[1]! > p[3]! || Math.abs(p[1]!) > 90 || Math.abs(p[3]!) > 90)
    throw new BadRequest('bbox must be "west,south,east,north" in degrees');
  return p as BBox;
}
function qGrade(v: unknown): string | undefined {
  if (v === undefined || v === '') return undefined;
  try {
    return gradeString(parseGrade(String(v)));
  } catch {
    throw new BadRequest('minGrade must be an Admiralty grade such as "B2"');
  }
}
function qBool(v: unknown, name: string): boolean | undefined {
  if (v === undefined || v === '') return undefined;
  if (v !== 'true' && v !== 'false') throw new BadRequest(`${name} must be "true" or "false"`);
  return v === 'true';
}
function qOneOf<T extends string>(v: unknown, name: string, allowed: readonly T[]): T | undefined {
  if (v === undefined || v === '') return undefined;
  if (!allowed.includes(v as T)) throw new BadRequest(`${name} must be one of ${allowed.join(', ')}`);
  return v as T;
}

const feature = (i: Incident) => ({
  type: 'Feature' as const,
  geometry: { type: 'Point' as const, coordinates: [i.geo!.lon, i.geo!.lat] },
  properties: {
    id: i.id, kind: i.kind, status: i.status, title: i.title, released: i.released, confidence: Number(i.confidence.toFixed(3)),
    independentSupport: i.independentSupport, rawItems: i.rawItems, echoReduction: Number(i.echoReduction.toFixed(3)),
    bestGrade: i.bestGrade ?? null, flags: i.flags, reasons: i.reasons, firstAt: i.firstAt, lastAt: i.lastAt, sharedIndicators: i.sharedIndicators,
  },
});

export function registerFusionRoutes(app: FastifyInstance, c: FusionRouteContext): void {
  const guard = async <T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BadRequest || e instanceof ValidationError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  };

  app.get('/api/fusion/status', async () => ({
    store: c.store.kind, queue: c.queueKind, items: await c.store.countItems(), claims: (await c.store.claims()).length,
    geoipRows: c.ips.csv.size, ledgerWebhook: Boolean(c.env.LEDGER_WEBHOOK_SECRET),
    embedding: { provider: c.embedding.name, dim: c.embedding.dim, semantic: c.embedding.semantic, ...(c.embeddingDegraded ? { degraded: c.embeddingDegraded } : {}) },
    geoip: { sources: c.ips.sources, notes: c.ips.notes },
    gazetteer: { sources: c.places.sources, notes: c.places.notes },
  }));

  // ---- ingestion: everything is validated, graded (F6 when ungraded) and queued; nothing is trusted.
  app.post('/api/ingest', (req, reply) =>
    guard(reply, async () => {
      const b = req.body;
      const list = isObj(b) && Array.isArray(b.items) ? b.items : isObj(b) && b.text !== undefined ? [b] : undefined;
      if (!list) throw new BadRequest('body must be {"items": [{"text", "sourceType", "sourceId", "grade"?, "at"?, "claim"?, "stance"?, "owner"?, "indicators"?, "geo"?, "claimedPlace"?}]}');
      if (list.length > 1000) throw new BadRequest('at most 1000 items per request');
      const items = list.map((x, i) => parseRawItem(x, `items[${i}]`));
      const ids = await c.fusion.ingest(items);
      return reply.code(202).send({ accepted: ids.length, ids });
    }),
  );

  app.get('/api/provenance', (req, reply) =>
    guard(reply, async () => {
      const q = req.query as Record<string, string | undefined>;
      const limit = q.limit === undefined ? 200 : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 2000) throw new BadRequest('limit must be between 1 and 2000');
      let indicator: string | undefined;
      if (q.indicator) {
        const at = q.indicator.indexOf(':');
        if (at < 1) throw new BadRequest('indicator must be "kind:value", e.g. "ip:203.0.113.9"');
        const n = normaliseIndicator(q.indicator.slice(0, at) as IndicatorKind, q.indicator.slice(at + 1));
        indicator = `${n.kind}:${n.value}`;
      }
      const since = qTime(q.since, 'since');
      const until = qTime(q.until, 'until');
      const bbox = qBBox(q.bbox);
      const minGrade = qGrade(q.minGrade);
      const kind = qOneOf(q.kind, 'kind', ['osint', 'ledger'] as const);
      const sourceType = qOneOf(q.sourceType, 'sourceType', ['telegram', 'feed', 'tool', 'web', 'sensor', 'file'] as const);
      const items = await c.store.queryItems({
        limit,
        ...(q.claim ? { claim: q.claim } : {}), ...(kind ? { kind } : {}), ...(sourceType ? { sourceType } : {}), ...(minGrade ? { minGrade } : {}),
        ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}), ...(bbox ? { bbox } : {}), ...(indicator ? { indicator } : {}),
        ...(q.q ? { near: (await c.embedding.embed([q.q], 'query'))[0]! } : {}),
      });
      // Entity links: indicators carried or mentioned by two or more of the returned items.
      const idx = new Map<string, { itemIds: string[]; structural: boolean }>();
      for (const i of items)
        for (const [list, structural] of [[i.indicators, true], [i.mentions, false]] as const)
          for (const x of list) {
            const k = `${x.kind}:${x.value}`;
            const e = idx.get(k) ?? { itemIds: [], structural: false };
            if (!e.itemIds.includes(i.id)) e.itemIds.push(i.id);
            e.structural ||= structural;
            idx.set(k, e);
          }
      const entityLinks = [...idx].filter(([, v]) => v.itemIds.length >= 2).map(([indicator, v]) => ({ indicator, ...v })).sort((a, b) => b.itemIds.length - a.itemIds.length || a.indicator.localeCompare(b.indicator));
      return { items, total: await c.store.countItems(), claims: await c.store.claims(), entityLinks };
    }),
  );

  // ---- corroboration: clusterItems + corroborate + canRelease
  app.post('/api/corroborate', (req, reply) =>
    guard(reply, async () => {
      const b = req.body;
      if (!isObj(b)) throw new BadRequest('body must be {"claim": string} or {"claim": string, "evidence": [...]}, plus optional "options"');
      if (typeof b.claim !== 'string' || !b.claim.trim()) throw new BadRequest('"claim" (the incident key) is required');
      const o = isObj(b.options) ? b.options : {};
      const opts: CorroborateRequest = {};
      for (const k of ['indicators', 'semantic'] as const)
        if (o[k] !== undefined) {
          if (typeof o[k] !== 'boolean') throw new BadRequest(`options.${k} must be a boolean`);
          opts[k] = o[k] as boolean;
        }
      for (const k of ['burstWindowMs', 'proximityKm'] as const)
        if (o[k] !== undefined) {
          if (o[k] !== null && (typeof o[k] !== 'number' || !(o[k] as number > 0))) throw new BadRequest(`options.${k} must be a positive number or null`);
          opts[k] = o[k] as number | null;
        }
      if (o.rule !== undefined) {
        if (!isObj(o.rule)) throw new BadRequest('options.rule must be an object');
        const r: NonNullable<CorroborateRequest['rule']> = {};
        for (const k of ['minIndependentSupport', 'minConfidence', 'maxContradiction'] as const)
          if (o.rule[k] !== undefined) {
            if (typeof o.rule[k] !== 'number' || (o.rule[k] as number) < 0) throw new BadRequest(`options.rule.${k} must be a non-negative number`);
            r[k] = o.rule[k] as number;
          }
        for (const k of ['blockEchoChamber', 'blockGeoMismatch'] as const)
          if (o.rule[k] !== undefined) {
            if (typeof o.rule[k] !== 'boolean') throw new BadRequest(`options.rule.${k} must be a boolean`);
            r[k] = o.rule[k] as boolean;
          }
        opts.rule = r;
      }
      if (b.evidence !== undefined) {
        if (!Array.isArray(b.evidence) || !b.evidence.length) throw new BadRequest('"evidence" must be a non-empty array');
        const claim = b.claim;
        const evidence = b.evidence.map((x, i): Evidence => {
          const r = parseRawItem(x, `evidence[${i}]`);
          return {
            id: r.externalId ?? `e${i + 1}`, claim, stance: r.stance ?? 'supports', text: r.text, grade: parseGrade(r.grade ?? 'F6'),
            origin: { id: r.sourceId, kind: r.sourceType, ...(r.owner ? { owner: r.owner } : {}) },
            indicators: (r.indicators ?? []).map(x2 => normaliseIndicator(x2.kind as IndicatorKind, x2.value)),
            ...(r.at !== undefined ? { at: r.at } : {}), ...(r.cites ? { cites: r.cites } : {}), ...(r.geo ? { geo: r.geo } : {}),
            ...(r.claimedPlace ? { claimedPlace: r.claimedPlace } : {}), ...(r.ipGeo ? { ipGeo: r.ipGeo } : {}),
          };
        });
        return c.fusion.corroborateEvidence(claim, evidence, opts);
      }
      const view = await c.fusion.corroborateClaim(b.claim, opts);
      return view ?? reply.code(404).send({ error: `no evidence is stored for claim "${b.claim}"` });
    }),
  );

  // ---- ACH
  app.post('/api/ach', (req, reply) =>
    guard(reply, async () => {
      const b = req.body;
      if (!isObj(b) || !Array.isArray(b.hypotheses) || !Array.isArray(b.evidence) || !isObj(b.cells))
        throw new BadRequest('body must be {"hypotheses": [{"id","label"}], "evidence": [{"id","label","grade"?}], "cells": {evidenceId: {hypothesisId: -2..2}}}');
      const named = (v: unknown, where: string) => {
        if (!isObj(v) || typeof v.id !== 'string' || !v.id || typeof v.label !== 'string') throw new BadRequest(`${where} must be {"id": string, "label": string}`);
        return { id: v.id, label: v.label };
      };
      const hypotheses = b.hypotheses.map((h, i) => named(h, `hypotheses[${i}]`));
      if (!hypotheses.length) throw new BadRequest('at least one hypothesis is required');
      const evidence = b.evidence.map((e, i) => {
        const n = named(e, `evidence[${i}]`);
        const g = (e as Record<string, unknown>).grade;
        if (g === undefined || g === null || g === '') return n;
        try {
          return { ...n, grade: parseGrade(String(g)) };
        } catch {
          throw new BadRequest(`evidence[${i}].grade must be an Admiralty grade such as "B2"`);
        }
      });
      for (const list of [hypotheses, evidence]) if (new Set(list.map(x => x.id)).size !== list.length) throw new BadRequest('ids must be unique');
      const hIds = new Set(hypotheses.map(h => h.id));
      const cells: AchInput['cells'] = {};
      for (const e of evidence) {
        const row = b.cells[e.id];
        cells[e.id] = {};
        if (row === undefined) continue;
        if (!isObj(row)) throw new BadRequest(`cells.${e.id} must be an object`);
        for (const [h, v] of Object.entries(row)) {
          if (!hIds.has(h)) throw new BadRequest(`cells.${e.id} refers to unknown hypothesis "${h}"`);
          // Off-scale values are rejected, never coerced: a model that fills the matrix does not get to invent a scale.
          if (![-2, -1, 0, 1, 2].includes(v as number)) throw new BadRequest(`cells.${e.id}.${h} must be -2, -1, 0, 1 or 2`);
          cells[e.id]![h] = v as Cell;
        }
      }
      const result = ach({ hypotheses, evidence, cells });
      const rule = { ...DEFAULT_ATTRIBUTION_RULE };
      if (isObj(b.rule))
        for (const k of ['minMargin', 'minDiagnostic', 'minCriticalWeight'] as const)
          if (b.rule[k] !== undefined) {
            if (typeof b.rule[k] !== 'number' || (b.rule[k] as number) < 0) throw new BadRequest(`rule.${k} must be a non-negative number`);
            rule[k] = b.rule[k] as number;
          }
      return { result, attribution: { ...attributionGate(result, rule), leader: result.leader, rule } };
    }),
  );

  // ---- geo
  app.get('/api/geo/incidents', (req, reply) =>
    guard(reply, async () => {
      const q = req.query as Record<string, string | undefined>;
      const released = qBool(q.released, 'released');
      const minGrade = qGrade(q.minGrade);
      const since = qTime(q.since, 'since');
      const until = qTime(q.until, 'until');
      const bbox = qBBox(q.bbox);
      const kind = qOneOf(q.kind, 'kind', ['claim', 'ring'] as const);
      const all = await c.store.queryIncidents({
        ...(released !== undefined ? { released } : {}), ...(minGrade ? { minGrade } : {}), ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}), ...(bbox ? { bbox } : {}), ...(kind ? { kind } : {}),
      });
      const located = all.filter(i => i.geo);
      // Entity-cluster links: a line between two members that share an indicator (or were otherwise judged coordinated).
      const links: unknown[] = [];
      // Drawn for rings only: a claim's members are sources, and a line between two sources' locations says nothing.
      for (const inc of located.filter(i => i.kind === 'ring')) {
        const wanted = inc.links.filter(l => l.reason === 'shared-indicator' || l.reason === 'burst' || l.reason === 'proximity').slice(0, 200);
        if (!wanted.length) continue;
        const geo = new Map<string, { lat: number; lon: number }>();
        for (const id of new Set(wanted.flatMap(l => [l.a, l.b]))) {
          const it = await c.store.getItem(id);
          if (it?.geo) geo.set(id, it.geo);
        }
        for (const l of wanted) {
          const a = geo.get(l.a);
          const b2 = geo.get(l.b);
          if (!a || !b2 || (a.lat === b2.lat && a.lon === b2.lon)) continue;
          links.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b2.lon, b2.lat]] }, properties: { kind: 'link', incident: inc.id, status: inc.status, reason: l.reason, detail: l.detail ?? null } });
        }
      }
      return {
        type: 'FeatureCollection',
        features: [...located.map(feature), ...links],
        meta: { incidents: all.length, located: located.length, withoutLocation: all.filter(i => !i.geo).map(i => ({ id: i.id, title: i.title, status: i.status })), store: c.store.kind },
      };
    }),
  );

  app.get('/api/geo/heatmap', (req, reply) =>
    guard(reply, async () => {
      const q = req.query as Record<string, string | undefined>;
      const cell = q.cell === undefined ? 0.05 : Number(q.cell);
      if (!(cell >= 0.001 && cell <= 10)) throw new BadRequest('cell must be a grid size in degrees between 0.001 and 10');
      const kind = qOneOf(q.kind, 'kind', ['osint', 'ledger'] as const);
      const proxyOnly = qBool(q.proxy, 'proxy');
      const since = qTime(q.since, 'since');
      const until = qTime(q.until, 'until');
      const bbox = qBBox(q.bbox);
      const cells = await c.store.heatmap({
        cell, ...(kind ? { kind } : {}), ...(proxyOnly ? { proxyOnly } : {}), ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}), ...(bbox ? { bbox } : {}),
      });
      return {
        type: 'FeatureCollection',
        features: cells.map(x => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [x.lon, x.lat] }, properties: { count: x.count } })),
        meta: { cell, cells: cells.length, events: cells.reduce((a, x) => a + x.count, 0), max: cells[0]?.count ?? 0, store: c.store.kind },
      };
    }),
  );

  app.get('/api/incidents/:id/history', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const history = await c.store.incidentHistory(id);
    return history.length ? { id, history } : reply.code(404).send({ error: `no history for incident "${id}"` });
  });

  // ---- collectors (operator-configured sources, run through the MCP gate proxy)
  const sources = (): CollectorSource[] => {
    if (!existsSync(c.collectorsFile)) writeFileSync(c.collectorsFile, JSON.stringify({ $comment: 'Collector sources. type: feed | telegram-export | jsonl. Only locations listed here can be collected.', sources: [] }, null, 2) + '\n');
    return parseCollectorConfig(JSON.parse(readFileSync(c.collectorsFile, 'utf8')));
  };
  app.get('/api/collectors', async (_req, reply) => {
    try {
      return { file: c.collectorsFile, sources: sources() };
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });
  app.post('/api/collectors/run', async (req, reply) => {
    const id = isObj(req.body) ? req.body.id : undefined;
    let list: CollectorSource[];
    try {
      list = sources();
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
    const src = list.find(s => s.id === id);
    if (!src) return reply.code(404).send({ error: `no collector source "${String(id)}" in ${c.collectorsFile}` });
    const r = await runCollector(src, { audit: c.audit });
    const ids = r.error ? [] : await c.fusion.ingest(r.items.map((x, i) => parseRawItem(x, `collected[${i}]`)));
    return reply.code(r.error ? 502 : 202).send({ id: src.id, verdict: r.decision.verdict, reasons: r.decision.reasons, accepted: ids.length, ...(r.error ? { error: r.error } : {}) });
  });

  // ---- ledger / session anomaly webhook: HMAC-authenticated, replay-limited
  app.register(async scope => {
    // The signature covers the exact bytes sent, so this route keeps the body as a string.
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    scope.post('/api/ingest/ledger', async (req, reply) => {
      const secret = c.env.LEDGER_WEBHOOK_SECRET;
      if (!secret) return reply.code(503).send({ error: 'the ledger webhook is disabled: set LEDGER_WEBHOOK_SECRET in .env.local' });
      const raw = typeof req.body === 'string' ? req.body : '';
      const tsHeader = String(req.headers['x-admiralty-timestamp'] ?? '');
      const sig = String(req.headers['x-admiralty-signature'] ?? '').replace(/^sha256=/, '');
      const ts = Number(tsHeader);
      if (!/^\d+$/.test(tsHeader) || Math.abs(Date.now() - ts) > 5 * 60_000) return reply.code(401).send({ error: 'missing or stale x-admiralty-timestamp (epoch ms, within 5 minutes)' });
      const want = createHmac('sha256', secret).update(`${tsHeader}.${raw}`).digest();
      const got = /^[0-9a-f]{64}$/i.test(sig) ? Buffer.from(sig, 'hex') : Buffer.alloc(0);
      if (got.length !== want.length || !timingSafeEqual(got, want)) return reply.code(401).send({ error: 'bad x-admiralty-signature' });
      try {
        const b: unknown = JSON.parse(raw);
        if (!isObj(b) || !Array.isArray(b.events)) throw new ValidationError('body must be {"events": [{"id", "account", "at"?, "ip"?, "asn"?, "proxy"?, "wallet"?, "device"?, "amount"?, "lat"?, "lon"?, "place"?}], "grade"?}');
        if (b.events.length > 5000) throw new ValidationError('at most 5000 events per request');
        const grade = b.grade === undefined ? 'B2' : gradeString(parseGrade(String(b.grade)));
        const events = b.events.map((e, i) => parseLedgerEvent(e, `events[${i}]`));
        const ids = await c.fusion.ingest(events.map(e => ledgerToRaw(e, grade)));
        return reply.code(202).send({ accepted: ids.length, ids });
      } catch (e) {
        if (e instanceof ValidationError || e instanceof SyntaxError || (e as Error).message.startsWith('Invalid Admiralty grade'))
          return reply.code(400).send({ error: (e as Error).message });
        throw e;
      }
    });
  });

  // ---- demo scenario (synthetic; idempotent thanks to de-duplication)
  app.post('/api/fusion/demo', async (_req, reply) => {
    if (c.env.ADMIRALTY_DEMO === '0') return reply.code(403).send({ error: 'demo data is disabled (ADMIRALTY_DEMO=0)' });
    const now = Date.now();
    c.ips.csv.load(DEMO_GEOIP);
    const raws: RawItem[] = [...demoItems(now), ...demoLedger(now).map(e => ledgerToRaw(e, 'B2'))];
    const ids = await c.fusion.ingest(raws);
    await c.fusion.idle();
    return { loaded: ids.length, items: await c.store.countItems(), claims: await c.store.claims() };
  });
}
