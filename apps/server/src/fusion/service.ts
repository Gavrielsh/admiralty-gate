/**
 * Fusion service: the pipeline from "something arrived" to "an incident on the map".
 *
 *   ingest-osint         normalise, de-duplicate, record in the ProvenanceLedger as UNTRUSTED with its grade, persist
 *   geo-enrich           resolve a location (supplied > coordinates in text > gazetteer > IP table), check consistency
 *   corroborate-cluster  recompute the incident(s) the item belongs to: clusterItems + corroborate + canRelease
 *
 * Everything that decides is the pure core library. This file only moves data between it, the store and the queue.
 */
import { createHash } from 'node:crypto';
import {
  SAMPLE_GAZETTEER, canRelease, checkGeoConsistency, clusterItems, corroborate, extractCoordinates, extractEntities,
  gradeString, normaliseIndicator, parseGrade, validPoint, weightOf,
  type Assessment, type ClusterLink, type ClusterOptions, type Evidence, type GeoPoint, type Indicator, type IndicatorKind,
  type Item, type OriginKind, type Place, type ProvenanceLedger, type PublishRule, type ReleaseDecision,
} from 'admiralty-gate';
import type { EventBus } from '../bus.js';
import type { EmbeddingProvider } from './embedding.js';
import type { IpResolver, PlaceResolver } from './georesolve.js';
import type { Handlers, JobQueue } from './queue.js';
import { SOURCE_TYPES, type FusionItem, type Incident, type IncidentSnapshot, type SourceType, type Store } from './types.js';

const KINDS: readonly IndicatorKind[] = ['ip', 'cidr', 'asn', 'wallet', 'txhash', 'domain', 'phone', 'telegram', 'handle', 'email', 'device', 'account'];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** What a caller (API client, collector, webhook) hands in. Everything except text and source is optional. */
export interface RawItem {
  text: string;
  sourceType: SourceType;
  sourceId: string;
  /** Stable id within the source (message id, GUID). Without it the id is derived from the content hash. */
  externalId?: string;
  owner?: string;
  grade?: string;
  at?: number;
  claim?: string;
  stance?: 'supports' | 'contradicts';
  cites?: string[];
  indicators?: { kind: string; value: string }[];
  geo?: GeoPoint;
  claimedPlace?: string;
  ipGeo?: GeoPoint;
  kind?: 'osint' | 'ledger';
  meta?: Record<string, unknown>;
}

export class ValidationError extends Error {}

const point = (v: unknown, where: string): GeoPoint | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v) || typeof v.lat !== 'number' || typeof v.lon !== 'number' || !validPoint({ lat: v.lat, lon: v.lon }))
    throw new ValidationError(`${where} must be {"lat": -90..90, "lon": -180..180}`);
  return { lat: v.lat, lon: v.lon };
};

/** Strict parse of one raw item: a wrong type is an error, never a silently dropped field. */
export function parseRawItem(v: unknown, where = 'item'): RawItem {
  if (!isObj(v)) throw new ValidationError(`${where} must be an object`);
  if (typeof v.text !== 'string' || !v.text.trim()) throw new ValidationError(`${where}.text must be a non-empty string`);
  if (v.text.length > 20_000) throw new ValidationError(`${where}.text is longer than 20000 characters`);
  if (!SOURCE_TYPES.includes(v.sourceType as SourceType)) throw new ValidationError(`${where}.sourceType must be one of ${SOURCE_TYPES.join(', ')}`);
  if (typeof v.sourceId !== 'string' || !v.sourceId.trim()) throw new ValidationError(`${where}.sourceId must be a non-empty string`);
  const out: RawItem = { text: v.text, sourceType: v.sourceType as SourceType, sourceId: v.sourceId.trim() };
  for (const k of ['externalId', 'owner', 'claim', 'claimedPlace'] as const)
    if (v[k] !== undefined) {
      if (typeof v[k] !== 'string') throw new ValidationError(`${where}.${k} must be a string`);
      if ((v[k] as string).trim()) out[k] = (v[k] as string).trim();
    }
  if (v.grade !== undefined) {
    if (typeof v.grade !== 'string') throw new ValidationError(`${where}.grade must be a string like "B2"`);
    try {
      out.grade = gradeString(parseGrade(v.grade));
    } catch (e) {
      throw new ValidationError(`${where}.grade: ${(e as Error).message}`);
    }
  }
  if (v.at !== undefined) {
    const t = typeof v.at === 'string' ? Date.parse(v.at) : v.at;
    if (typeof t !== 'number' || !Number.isFinite(t)) throw new ValidationError(`${where}.at must be epoch milliseconds or an ISO date`);
    out.at = t;
  }
  if (v.stance !== undefined) {
    if (v.stance !== 'supports' && v.stance !== 'contradicts') throw new ValidationError(`${where}.stance must be "supports" or "contradicts"`);
    out.stance = v.stance;
  }
  if (v.cites !== undefined) {
    if (!Array.isArray(v.cites) || v.cites.some(c => typeof c !== 'string')) throw new ValidationError(`${where}.cites must be an array of item ids`);
    out.cites = v.cites as string[];
  }
  if (v.indicators !== undefined) {
    if (!Array.isArray(v.indicators)) throw new ValidationError(`${where}.indicators must be an array`);
    out.indicators = v.indicators.map((i, n) => {
      if (!isObj(i) || !KINDS.includes(i.kind as IndicatorKind) || typeof i.value !== 'string' || !i.value.trim())
        throw new ValidationError(`${where}.indicators[${n}] must be {"kind": one of ${KINDS.join('|')}, "value": string}`);
      return { kind: i.kind as string, value: i.value };
    });
  }
  const geo = point(v.geo, `${where}.geo`);
  if (geo) out.geo = geo;
  const ipGeo = point(v.ipGeo, `${where}.ipGeo`);
  if (ipGeo) out.ipGeo = ipGeo;
  if (v.kind !== undefined) {
    if (v.kind !== 'osint' && v.kind !== 'ledger') throw new ValidationError(`${where}.kind must be "osint" or "ledger"`);
    out.kind = v.kind;
  }
  if (v.meta !== undefined) {
    if (!isObj(v.meta)) throw new ValidationError(`${where}.meta must be an object`);
    out.meta = v.meta;
  }
  return out;
}

const ORIGIN_KIND: Record<SourceType, OriginKind> = { telegram: 'telegram', feed: 'feed', tool: 'tool', web: 'web', sensor: 'sensor', file: 'file' };
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const centre = (p: Place): GeoPoint => ({ lat: (p.bbox[1] + p.bbox[3]) / 2, lon: (p.bbox[0] + p.bbox[2]) / 2 });
const area = (p: Place): number => (p.bbox[2] - p.bbox[0]) * (p.bbox[3] - p.bbox[1]);

export interface FusionOptions {
  store: Store;
  bus: EventBus;
  ledger: ProvenanceLedger;
  embedding: EmbeddingProvider;
  ips: IpResolver;
  places: PlaceResolver;
  /** Only ledger events newer than this are considered for rings. Default 7 days. */
  ringWindowMs?: number;
  /** Also link ledger events from different accounts within this distance (PostGIS ST_DWithin). Off by default. */
  ringProximityKm?: number;
  /** Time window for the proximity link. Default 10 minutes. */
  ringProximityWindowMs?: number;
  /** Cosine similarity above which two items of one claim count as the same post in other words. Default 0.92. */
  semanticThreshold?: number;
  /** Accounts needed before linked ledger events are reported as a ring. Default 3. */
  minRingAccounts?: number;
  /** Window for synchronised-post linking on claims. Default 10 minutes. */
  burstWindowMs?: number;
  clock?: () => number;
}

export interface CorroborateRequest {
  indicators?: boolean;
  /** Use embedding similarity to merge translated or paraphrased copies posted close in time. Default: on when the provider is semantic. */
  semantic?: boolean;
  burstWindowMs?: number | null;
  proximityKm?: number | null;
  rule?: Partial<PublishRule>;
}

export interface CorroborationView {
  claim: string;
  assessment: Assessment;
  release: ReleaseDecision;
  rawSources: number;
  independentClusters: number;
  noisyOr: { support: number; contradiction: number; confidence: number };
  echoReduction: number;
  gradeDistribution: Record<string, number>;
  members: { id: string; sourceId: string; sourceType: string; grade: string; stance: string; text: string; at: number; cluster: string }[];
}

export class FusionService {
  readonly handlers: Handlers;
  private queue!: JobQueue;
  private readonly clock: () => number;

  constructor(private readonly o: FusionOptions) {
    this.clock = o.clock ?? (() => Date.now());
    this.handlers = {
      'ingest-osint': d => this.ingestJob(d as { item: RawItem; id: string }),
      'geo-enrich': d => this.geoJob(d as { id: string }),
      'corroborate-cluster': d => this.clusterJob(d as { claim?: string; ledger?: boolean }),
    };
  }

  attach(queue: JobQueue): void {
    this.queue = queue;
  }

  /** After a restart: put every stored item back into the provenance ledger, untrusted and graded. */
  async rebuildLedger(): Promise<number> {
    const items = await this.o.store.queryItems({ limit: 100_000 });
    for (const i of items.reverse()) this.record(i);
    return items.length;
  }

  private record(i: FusionItem): string {
    return this.o.ledger.addUntrusted(i.text, {
      id: i.sourceId, kind: ORIGIN_KIND[i.sourceType], grade: parseGrade(i.grade), ...(i.owner ? { owner: i.owner } : {}),
    }).id;
  }

  /** Deterministic id, so a client learns the ids of what it submitted before the queue has run. */
  idFor(r: RawItem): string {
    const h = sha(`${r.sourceType}|${r.sourceId}|${r.text}`);
    return r.externalId ? `${r.sourceType}:${r.sourceId}:${r.externalId}` : `${r.sourceType}:${r.sourceId}:${h.slice(0, 16)}`;
  }

  async ingest(items: RawItem[]): Promise<string[]> {
    const ids: string[] = [];
    for (const item of items) {
      const id = this.idFor(item);
      ids.push(id);
      await this.queue.add('ingest-osint', { item, id });
    }
    return ids;
  }

  idle(): Promise<void> {
    return this.queue.idle();
  }

  private async ingestJob({ item: r, id }: { item: RawItem; id: string }): Promise<void> {
    const now = this.clock();
    const item: FusionItem = {
      id,
      hash: sha(`${r.sourceType}|${r.sourceId}|${r.text}`),
      kind: r.kind ?? 'osint',
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      // An ungraded source is F6: recorded, visible, and worth nothing as evidence until someone grades it.
      grade: r.grade ?? 'F6',
      text: r.text,
      at: r.at ?? now,
      ingestedAt: now,
      indicators: (r.indicators ?? []).map(i => normaliseIndicator(i.kind as IndicatorKind, i.value)),
      mentions: extractEntities(r.text),
      geoFlags: [],
      ...(r.owner ? { owner: r.owner } : {}),
      ...(r.claim ? { claim: r.claim } : {}),
      ...(r.claim ? { stance: r.stance ?? 'supports' } : {}),
      ...(r.cites?.length ? { cites: r.cites } : {}),
      ...(r.geo ? { geo: r.geo, geoSource: 'supplied' as const } : {}),
      ...(r.claimedPlace ? { claimedPlace: r.claimedPlace } : {}),
      ...(r.ipGeo ? { ipGeo: r.ipGeo } : {}),
      ...(r.meta ? { meta: r.meta } : {}),
    };
    const [vector] = await this.o.embedding.embed([item.text], 'passage');
    if (!(await this.o.store.putItem(item, vector!))) {
      this.o.bus.emit('fusion.duplicate', { id });
      return;
    }
    // Untrusted, graded, in the ledger: before anything can be synthesised or released from it.
    const spanId = this.record(item);
    await this.o.store.updateItem(id, { spanId });
    this.o.bus.emit('fusion.ingested', { id, kind: item.kind, sourceType: item.sourceType, sourceId: item.sourceId, grade: item.grade, claim: item.claim ?? null });
    await this.queue.add('geo-enrich', { id });
  }

  private async geoJob({ id }: { id: string }): Promise<void> {
    const item = await this.o.store.getItem(id);
    if (!item) return;
    const patch: Partial<FusionItem> = {};
    let { geo, ipGeo } = item;
    const ip = [...item.indicators, ...(item.kind === 'ledger' ? item.mentions : [])].find(i => i.kind === 'ip');
    const found = ip ? this.o.ips.lookup(ip.value) : undefined;
    if (!ipGeo && found?.point) ipGeo = patch.ipGeo = found.point;
    if (found?.asn && item.meta?.asn === undefined) patch.meta = { ...item.meta, asn: found.asn, ...(found.org ? { asnOrg: found.org } : {}) };
    const places = await this.o.places.resolve(item.text, item.claimedPlace);
    if (places.length) patch.places = places;
    if (!geo) {
      const inText = extractCoordinates(item.text)[0];
      const named = [...places].sort((a, b) => area(a) - area(b))[0];
      if (inText) [geo, patch.geoSource] = [inText, 'text'];
      else if (named) [geo, patch.geoSource] = [centre(named), 'gazetteer'];
      else if (ipGeo) [geo, patch.geoSource] = [ipGeo, 'ip'];
      if (geo) patch.geo = geo;
    }
    // A location derived FROM the place name or FROM the IP cannot contradict it; only independent coordinates can.
    const src = patch.geoSource ?? item.geoSource;
    if (geo && src !== 'gazetteer')
      patch.geoFlags = checkGeoConsistency(
        { point: geo, text: item.text, ...(item.claimedPlace ? { claimedPlace: item.claimedPlace } : {}), ...(ipGeo && src !== 'ip' ? { ipGeo } : {}) },
        { gazetteer: places },
      );
    if (Object.keys(patch).length) await this.o.store.updateItem(id, patch);
    if (item.claim) await this.queue.add('corroborate-cluster', { claim: item.claim });
    if (item.kind === 'ledger') await this.queue.add('corroborate-cluster', { ledger: true });
  }

  /** Re-embed every stored item (after the embedding model, and so the vector length, changed). */
  async reembedAll(): Promise<number> {
    let after = '';
    let n = 0;
    for (;;) {
      const page = await this.o.store.pageItems(after, 64);
      if (!page.length) return n;
      const vectors = await this.o.embedding.embed(page.map(p => p.text), 'passage');
      for (let i = 0; i < page.length; i++) await this.o.store.setEmbedding(page[i]!.id, vectors[i]!);
      n += page.length;
      after = page[page.length - 1]!.id;
    }
  }

  private async recordHistory(inc: Incident): Promise<void> {
    const snap: IncidentSnapshot = { at: this.clock(), status: inc.status, released: inc.released, confidence: Number(inc.confidence.toFixed(4)), independentSupport: inc.independentSupport, rawItems: inc.rawItems, flags: inc.flags, reasons: inc.reasons };
    const last = (await this.o.store.incidentHistory(inc.id)).pop();
    const same = last && last.status === snap.status && last.independentSupport === snap.independentSupport && last.rawItems === snap.rawItems && last.flags.join('|') === snap.flags.join('|');
    if (!same) await this.o.store.appendIncidentHistory(inc.id, snap);
  }

  private async clusterJob(d: { claim?: string; ledger?: boolean }): Promise<void> {
    if (d.claim) {
      const view = await this.corroborateClaim(d.claim);
      if (view) {
        const inc = await this.claimIncident(view);
        await this.o.store.putIncident(inc);
        await this.recordHistory(inc);
        this.o.bus.emit('incident.updated', { id: inc.id, kind: inc.kind, status: inc.status, title: inc.title });
      }
    }
    if (d.ledger) {
      const rings = await this.detectRings();
      await this.o.store.replaceIncidents('ring', rings);
      for (const r of rings) await this.recordHistory(r);
      this.o.bus.emit('incident.updated', { kind: 'ring', count: rings.length });
    }
  }

  private clusterOptions(req: CorroborateRequest = {}, items: readonly FusionItem[] = [], pairs: readonly { a: string; b: string; score: number }[] = []): ClusterOptions {
    const burst = req.burstWindowMs === null ? undefined : (req.burstWindowMs ?? this.o.burstWindowMs ?? 600_000);
    // The gazetteer for the core's consistency check is exactly the places already resolved for these items.
    const places = new Map<string, Place>();
    for (const i of items) for (const p of i.places ?? []) places.set(p.name, places.has(p.name) ? { ...p, aliases: [...new Set([...(places.get(p.name)!.aliases ?? []), ...(p.aliases ?? [])])] } : p);
    return {
      gazetteer: items.length ? [...places.values()] : SAMPLE_GAZETTEER,
      // Similar meaning merges two items only when they were also posted close together: independent outlets
      // describing the same event are similar too, and must stay independent.
      ...(pairs.length ? { semantic: { pairs, threshold: this.o.semanticThreshold ?? 0.92, withinMs: burst ?? 600_000 } } : {}),
      // Within one claim, an indicator carried by most of the evidence IS the finding (a hub channel), so hub
      // suppression is off here. Ring detection over the whole event population keeps it on.
      ...(req.indicators === false ? {} : { indicators: { maxShare: 1 } }),
      ...(burst ? { burst: { windowMs: burst } } : {}),
      ...(req.proximityKm ? { proximity: { radiusKm: req.proximityKm } } : {}),
    };
  }

  private toEvidence(i: FusionItem, claim: string): Evidence {
    return {
      id: i.id, claim, stance: i.stance ?? 'supports', text: i.text, at: i.at, grade: parseGrade(i.grade),
      origin: { id: i.sourceId, kind: ORIGIN_KIND[i.sourceType], ...(i.owner ? { owner: i.owner } : {}) },
      indicators: i.indicators,
      ...(i.cites ? { cites: i.cites } : {}),
      // Only independently obtained coordinates are evidence about location.
      ...(i.geo && i.geoSource !== 'gazetteer' && i.geoSource !== 'ip' ? { geo: i.geo } : {}),
      ...(i.claimedPlace ? { claimedPlace: i.claimedPlace } : {}),
      ...(i.ipGeo ? { ipGeo: i.ipGeo } : {}),
    };
  }

  /** clusterItems + corroborate + canRelease for one stored claim. */
  async corroborateClaim(claim: string, req: CorroborateRequest = {}): Promise<CorroborationView | undefined> {
    const items = await this.o.store.queryItems({ claim, limit: 5000 });
    if (!items.length) return undefined;
    const semantic = req.semantic ?? this.o.embedding.semantic;
    const pairs = semantic ? await this.o.store.similarPairs(claim, this.o.semanticThreshold ?? 0.92) : [];
    return this.corroborateEvidence(claim, items.map(i => this.toEvidence(i, claim)), req, items, pairs);
  }

  corroborateEvidence(claim: string, evidence: Evidence[], req: CorroborateRequest = {}, items?: FusionItem[], pairs: readonly { a: string; b: string; score: number }[] = []): CorroborationView {
    const assessment = corroborate(evidence, this.clusterOptions(req, items, pairs))[0]!;
    const rule = { ...({ minIndependentSupport: 2, minConfidence: 0.8, maxContradiction: 0.3, blockEchoChamber: true, blockGeoMismatch: true } satisfies PublishRule), ...req.rule };
    const clusterOf = new Map(assessment.clusters.flatMap(c => c.members.map(m => [m, c.id] as const)));
    const dist: Record<string, number> = {};
    for (const e of evidence) {
      const g = e.grade ? gradeString(e.grade) : 'F6';
      dist[g] = (dist[g] ?? 0) + 1;
    }
    const byId = new Map(items?.map(i => [i.id, i]));
    return {
      claim,
      assessment,
      release: canRelease(assessment, rule),
      rawSources: evidence.length,
      independentClusters: new Set(assessment.clusters.map(c => c.id)).size,
      noisyOr: { support: assessment.support, contradiction: assessment.contradiction, confidence: assessment.confidence },
      echoReduction: assessment.echoReduction,
      gradeDistribution: Object.fromEntries(Object.entries(dist).sort()),
      members: evidence.map(e => ({
        id: e.id, sourceId: e.origin.id, sourceType: byId.get(e.id)?.sourceType ?? e.origin.kind, grade: e.grade ? gradeString(e.grade) : 'F6',
        stance: e.stance, text: e.text.slice(0, 280), at: e.at ?? 0, cluster: clusterOf.get(e.id) ?? e.id,
      })),
    };
  }

  private async claimIncident(v: CorroborationView): Promise<Incident> {
    const items = await this.o.store.queryItems({ claim: v.claim, limit: 5000 });
    const flagged = new Set(Object.keys(v.assessment.geoFlags));
    // Locate the incident from supporting items whose coordinates are not themselves in question.
    const pts = items.filter(i => i.geo && (i.stance ?? 'supports') === 'supports' && !flagged.has(i.id)).map(i => i.geo!);
    const best = items.filter(i => (i.stance ?? 'supports') === 'supports').map(i => parseGrade(i.grade)).sort((a, b) => weightOf(b) - weightOf(a))[0];
    const times = items.map(i => i.at);
    return {
      id: `claim:${v.claim}`,
      kind: 'claim',
      status: v.release.allowed ? 'released' : 'quarantined',
      title: v.claim,
      released: v.release.allowed,
      reasons: v.release.reasons,
      confidence: v.assessment.confidence,
      phrase: v.assessment.phrase,
      independentSupport: v.assessment.independentSupport,
      rawItems: v.rawSources,
      echoReduction: v.echoReduction,
      flags: v.assessment.flags,
      firstAt: Math.min(...times),
      lastAt: Math.max(...times),
      memberIds: items.map(i => i.id),
      links: v.assessment.links,
      sharedIndicators: sharedIndicators(items),
      updatedAt: this.clock(),
      ...(pts.length ? { geo: { lat: avg(pts.map(p => p.lat)), lon: avg(pts.map(p => p.lon)) } } : {}),
      ...(best ? { bestGrade: gradeString(best) } : {}),
    };
  }

  /**
   * Fraud rings: ledger events from different accounts joined by a shared wallet, device or (non-proxy) IP.
   *
   * The database does the heavy part: a time-window filter, GROUP BY on each structural indicator, the
   * two-account rule and the hub cap (an indicator on more than half of the events links nothing), and optionally
   * a PostGIS ST_DWithin self-join for events at the same place and time. Only events that are linked to something
   * come back; the core then computes connected components over that subset.
   */
  async detectRings(): Promise<Incident[]> {
    const since = this.clock() - (this.o.ringWindowMs ?? 7 * 86_400_000);
    const total = await this.o.store.countLedger(since);
    if (!total) return [];
    const kinds = ['wallet', 'device', 'ip', 'account'];
    const maxHolders = total >= 4 ? Math.max(2, Math.floor(total * 0.5)) : total;
    const groups = await this.o.store.sharedIndicatorGroups({ since, kinds, maxHolders });
    const near = this.o.ringProximityKm
      ? await this.o.store.proximityPairs({ since, radiusM: this.o.ringProximityKm * 1000, windowMs: this.o.ringProximityWindowMs ?? 600_000 })
      : [];
    const linked = new Set<string>([...groups.flatMap(g => g.itemIds), ...near.flat()]);
    if (!linked.size) return [];
    let events = await this.o.store.getItems([...linked]);
    // An account's other events belong to the same origin and can bridge two groups.
    const mates = await this.o.store.accountEvents([...new Set(events.map(e => e.sourceId))], since);
    const extra = mates.flatMap(m => m.itemIds).filter(i => !linked.has(i));
    if (extra.length) events = [...events, ...(await this.o.store.getItems(extra))];
    events.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const items: Item[] = events.map(e => ({
      id: e.id, text: e.text, origin: { id: e.sourceId, kind: 'sensor' }, at: e.at, indicators: e.indicators,
      ...(e.geo ? { geo: e.geo } : {}), ...(e.ipGeo ? { ipGeo: e.ipGeo } : {}),
    }));
    // Hubs were already removed in SQL against the whole population, so the core must not re-judge them on the subset.
    const { clusters, links } = clusterItems(items, {
      similarity: 2,
      indicators: { kinds: kinds as IndicatorKind[], maxShare: 1 },
      ...(this.o.ringProximityKm ? { proximity: { radiusKm: this.o.ringProximityKm, windowMs: this.o.ringProximityWindowMs ?? 600_000 } } : {}),
    });
    const byId = new Map(events.map(e => [e.id, e]));
    const rings: Incident[] = [];
    for (const members of clusters.values()) {
      const evs = members.map(m => byId.get(m)!);
      const accounts = new Set(evs.map(e => e.sourceId));
      if (accounts.size < (this.o.minRingAccounts ?? 3)) continue;
      const pts = evs.filter(e => e.geo).map(e => e.geo!);
      const inRing = new Set(members);
      const ringLinks: ClusterLink[] = links.filter(l => (l.reason === 'shared-indicator' || l.reason === 'proximity') && inRing.has(l.a) && inRing.has(l.b));
      const proxies = evs.filter(e => e.meta?.proxy === true).length;
      const mismatched = evs.filter(e => e.geoFlags.length).length;
      const anchor = [...members].sort()[0]!;
      rings.push({
        id: `ring:${sha(anchor).slice(0, 12)}`,
        kind: 'ring',
        status: 'ring',
        title: `${accounts.size} accounts linked by ${sharedIndicators(evs).length} shared indicator(s)`,
        released: false,
        reasons: ['a ring is a detection for an analyst to review, not a corroborated claim'],
        confidence: 0,
        independentSupport: 1,
        rawItems: evs.length,
        echoReduction: evs.length ? 1 - 1 / evs.length : 0,
        flags: [...(proxies ? [`${proxies} event(s) through a proxy or VPN`] : []), ...(mismatched ? [`${mismatched} event(s) with a location mismatch`] : [])],
        firstAt: Math.min(...evs.map(e => e.at)),
        lastAt: Math.max(...evs.map(e => e.at)),
        memberIds: members,
        links: ringLinks,
        sharedIndicators: sharedIndicators(evs),
        updatedAt: this.clock(),
        ...(pts.length ? { geo: { lat: avg(pts.map(p => p.lat)), lon: avg(pts.map(p => p.lon)) } } : {}),
        bestGrade: evs.map(e => parseGrade(e.grade)).sort((a, b) => weightOf(b) - weightOf(a)).map(gradeString)[0]!,
      });
    }
    return rings.sort((a, b) => b.rawItems - a.rawItems || a.id.localeCompare(b.id));
  }
}

const avg = (xs: number[]): number => Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(6));

/** Structural indicators carried by at least two of the items. */
export function sharedIndicators(items: { indicators: Indicator[] }[]): string[] {
  const n = new Map<string, number>();
  for (const i of items) for (const k of new Set(i.indicators.map(x => `${x.kind}:${x.value}`))) n.set(k, (n.get(k) ?? 0) + 1);
  return [...n].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
}

export interface LedgerEvent {
  id: string;
  at?: number;
  account: string;
  ip?: string;
  asn?: string;
  proxy?: boolean;
  wallet?: string;
  device?: string;
  amount?: number;
  lat?: number;
  lon?: number;
  place?: string;
}

export function parseLedgerEvent(v: unknown, where: string): LedgerEvent {
  if (!isObj(v)) throw new ValidationError(`${where} must be an object`);
  const str = (k: string, required = false): string | undefined => {
    if (v[k] === undefined || v[k] === null) {
      if (required) throw new ValidationError(`${where}.${k} is required`);
      return undefined;
    }
    if (typeof v[k] !== 'string' && typeof v[k] !== 'number') throw new ValidationError(`${where}.${k} must be a string`);
    const s = String(v[k]).trim();
    if (!s && required) throw new ValidationError(`${where}.${k} is required`);
    if (s.length > 200) throw new ValidationError(`${where}.${k} is too long`);
    return s || undefined;
  };
  const e: LedgerEvent = { id: str('id', true)!, account: str('account', true)! };
  for (const k of ['ip', 'asn', 'wallet', 'device', 'place'] as const) {
    const s = str(k);
    if (s) e[k] = s;
  }
  if (e.ip && extractEntities(e.ip).every(i => i.kind !== 'ip')) throw new ValidationError(`${where}.ip is not an IPv4 address`);
  if (v.proxy !== undefined) {
    if (typeof v.proxy !== 'boolean') throw new ValidationError(`${where}.proxy must be a boolean`);
    e.proxy = v.proxy;
  }
  if (v.amount !== undefined) {
    if (typeof v.amount !== 'number' || !Number.isFinite(v.amount)) throw new ValidationError(`${where}.amount must be a number`);
    e.amount = v.amount;
  }
  if (v.at !== undefined) {
    const t = typeof v.at === 'string' ? Date.parse(v.at) : v.at;
    if (typeof t !== 'number' || !Number.isFinite(t)) throw new ValidationError(`${where}.at must be epoch milliseconds or an ISO date`);
    e.at = t;
  }
  if (v.lat !== undefined || v.lon !== undefined) {
    const p = point({ lat: v.lat, lon: v.lon }, `${where} lat/lon`)!;
    e.lat = p.lat;
    e.lon = p.lon;
  }
  return e;
}

/** A ledger/session anomaly as a provenance item. Sensor telemetry is still untrusted data: it informs, it does not authorise. */
export function ledgerToRaw(e: LedgerEvent, grade: string): RawItem {
  const indicators: { kind: string; value: string }[] = [];
  if (e.wallet) indicators.push({ kind: 'wallet', value: e.wallet });
  if (e.device) indicators.push({ kind: 'device', value: e.device });
  // A proxy or VPN exit address is shared by strangers, so it is not treated as linking two accounts.
  if (e.ip && !e.proxy) indicators.push({ kind: 'ip', value: e.ip });
  const parts = [`ledger event ${e.id}`, `account ${e.account}`, e.ip ? `ip ${e.ip}` : '', e.asn ? `asn AS${e.asn.replace(/^as/i, '')}` : '',
    e.wallet ? `wallet ${e.wallet}` : '', e.device ? `device ${e.device}` : '', e.amount !== undefined ? `amount ${e.amount}` : '',
    e.proxy ? 'via proxy' : '', e.place ? `at ${e.place}` : ''].filter(Boolean);
  return {
    kind: 'ledger', sourceType: 'sensor', sourceId: `account:${e.account}`, externalId: e.id, text: parts.join(' '), grade, indicators,
    meta: { proxy: e.proxy === true, ...(e.ip ? { ip: e.ip } : {}), ...(e.asn ? { asn: e.asn } : {}), ...(e.amount !== undefined ? { amount: e.amount } : {}) },
    ...(e.at !== undefined ? { at: e.at } : {}),
    ...(e.lat !== undefined && e.lon !== undefined ? { geo: { lat: e.lat, lon: e.lon } } : {}),
    ...(e.place ? { claimedPlace: e.place } : {}),
  };
}
