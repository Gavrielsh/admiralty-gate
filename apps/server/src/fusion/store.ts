import { meets, parseGrade } from 'admiralty-gate';
import { cosine } from './embed.js';
import { haversineKm, type Place } from 'admiralty-gate';
import type { ApprovalRow, ApprovalState, AuditMirrorRow, BBox, CallRow, FusionItem, HeatCell, HeatQuery, Incident, IncidentQuery, IncidentSnapshot, IndicatorGroup, ItemQuery, Store } from './types.js';

export const inBBox = (p: { lat: number; lon: number } | undefined, b: BBox | undefined): boolean =>
  !b || (!!p && p.lon >= b[0] && p.lat >= b[1] && p.lon <= b[2] && p.lat <= b[3]);

export const gradeOk = (grade: string | undefined, min: string | undefined): boolean => {
  if (!min) return true;
  if (!grade) return false;
  return meets(parseGrade(grade), parseGrade(min));
};

/** In-process store: the default when DATABASE_URL is not set, and the reference the Postgres store is tested against. */
export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private readonly items = new Map<string, { item: FusionItem; embedding: number[] }>();
  private readonly hashes = new Set<string>();
  private readonly incidents = new Map<string, Incident>();
  private mirror: AuditMirrorRow[] = [];

  private readonly calls = new Map<string, CallRow>();
  private readonly approvals = new Map<string, ApprovalRow>();
  private readonly history = new Map<string, IncidentSnapshot[]>();
  private readonly geocode = new Map<string, Place | undefined>();
  private readonly kv = new Map<string, string>();
  private dim = 0;

  async init(dim: number): Promise<{ reembed: boolean }> {
    const reembed = this.dim !== 0 && this.dim !== dim && this.items.size > 0;
    this.dim = dim;
    return { reembed };
  }
  async close(): Promise<void> {}

  async getItems(ids: readonly string[]): Promise<FusionItem[]> {
    return ids.map(i => this.items.get(i)?.item).filter((x): x is FusionItem => !!x).map(x => structuredClone(x));
  }

  async setEmbedding(id: string, embedding: number[]): Promise<void> {
    const e = this.items.get(id);
    if (e) e.embedding = embedding;
  }

  async pageItems(afterId: string, limit: number): Promise<{ id: string; text: string }[]> {
    return [...this.items.keys()].sort().filter(k => k > afterId).slice(0, limit).map(id => ({ id, text: this.items.get(id)!.item.text }));
  }

  async similarPairs(claim: string, minScore: number, limit = 5000): Promise<{ a: string; b: string; score: number }[]> {
    const rows = [...this.items.values()].filter(e => e.item.claim === claim).sort((a, b) => a.item.id.localeCompare(b.item.id));
    const out: { a: string; b: string; score: number }[] = [];
    for (let i = 0; i < rows.length && out.length < limit; i++)
      for (let j = i + 1; j < rows.length && out.length < limit; j++) {
        const score = cosine(rows[i]!.embedding, rows[j]!.embedding);
        if (score >= minScore) out.push({ a: rows[i]!.item.id, b: rows[j]!.item.id, score });
      }
    return out;
  }

  private ledger(since?: number): FusionItem[] {
    return [...this.items.values()].map(e => e.item).filter(i => i.kind === 'ledger' && (since === undefined || i.at >= since)).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  }

  async sharedIndicatorGroups(q: { since?: number; kinds: readonly string[]; maxHolders: number }): Promise<IndicatorGroup[]> {
    const groups = new Map<string, FusionItem[]>();
    for (const i of this.ledger(q.since))
      for (const x of new Set(i.indicators.filter(k => q.kinds.includes(k.kind)).map(k => `${k.kind}:${k.value}`))) groups.set(x, [...(groups.get(x) ?? []), i]);
    return [...groups].filter(([, list]) => new Set(list.map(i => i.sourceId)).size >= 2 && list.length <= q.maxHolders).map(([key, list]) => ({ key, itemIds: list.map(i => i.id) })).sort((a, b) => a.key.localeCompare(b.key));
  }

  async accountEvents(accounts: readonly string[], since?: number): Promise<IndicatorGroup[]> {
    const want = new Set(accounts);
    const by = new Map<string, string[]>();
    for (const i of this.ledger(since)) if (want.has(i.sourceId)) by.set(i.sourceId, [...(by.get(i.sourceId) ?? []), i.id]);
    return [...by].filter(([, ids]) => ids.length >= 2).map(([key, itemIds]) => ({ key, itemIds }));
  }

  async proximityPairs(q: { since?: number; radiusM: number; windowMs: number; limit?: number }): Promise<[string, string][]> {
    const ev = this.ledger(q.since).filter(i => i.geo);
    const out: [string, string][] = [];
    for (let i = 0; i < ev.length; i++)
      for (let j = i + 1; j < ev.length && out.length < (q.limit ?? 20_000); j++) {
        const a = ev[i]!;
        const b = ev[j]!;
        if (a.sourceId === b.sourceId || Math.abs(a.at - b.at) > q.windowMs) continue;
        if (haversineKm(a.geo!, b.geo!) * 1000 <= q.radiusM) out.push(a.id < b.id ? [a.id, b.id] : [b.id, a.id]);
      }
    return out;
  }

  async countLedger(since?: number): Promise<number> {
    return this.ledger(since).length;
  }

  async putCall(row: CallRow): Promise<void> {
    this.calls.set(row.id, structuredClone(row));
  }

  async listCalls(limit: number): Promise<CallRow[]> {
    return [...this.calls.values()].sort((a, b) => b.at - a.at || b.id.localeCompare(a.id)).slice(0, limit).map(r => structuredClone(r));
  }

  async putApproval(row: ApprovalRow): Promise<void> {
    this.approvals.set(row.id, structuredClone(row));
  }

  async listApprovals(q: { state?: ApprovalState; limit?: number }): Promise<ApprovalRow[]> {
    return [...this.approvals.values()].filter(a => !q.state || a.state === q.state).sort((a, b) => b.requestedAt - a.requestedAt || b.id.localeCompare(a.id)).slice(0, q.limit ?? 200).map(r => structuredClone(r));
  }

  async expirePendingApprovals(note: string, at: number): Promise<number> {
    let n = 0;
    for (const a of this.approvals.values())
      if (a.state === 'pending') {
        Object.assign(a, { state: 'expired', resolvedAt: at, note });
        n++;
      }
    return n;
  }

  async appendIncidentHistory(id: string, s: IncidentSnapshot): Promise<void> {
    this.history.set(id, [...(this.history.get(id) ?? []), structuredClone(s)]);
  }

  async incidentHistory(id: string): Promise<IncidentSnapshot[]> {
    return structuredClone(this.history.get(id) ?? []);
  }

  async getGeocode(query: string): Promise<{ hit: boolean; place?: Place }> {
    if (!this.geocode.has(query)) return { hit: false };
    const place = this.geocode.get(query);
    return place ? { hit: true, place } : { hit: true };
  }

  async putGeocode(query: string, place: Place | undefined): Promise<void> {
    this.geocode.set(query, place);
  }

  async getKv(key: string): Promise<string | undefined> {
    return this.kv.get(key);
  }

  async putKv(key: string, value: string): Promise<void> {
    this.kv.set(key, value);
  }

  async putItem(item: FusionItem, embedding: number[]): Promise<boolean> {
    if (this.hashes.has(item.hash) || this.items.has(item.id)) return false;
    this.hashes.add(item.hash);
    this.items.set(item.id, { item: structuredClone(item), embedding });
    return true;
  }

  async updateItem(id: string, patch: Partial<FusionItem>): Promise<void> {
    const e = this.items.get(id);
    if (e) Object.assign(e.item, structuredClone(patch));
  }

  async getItem(id: string): Promise<FusionItem | undefined> {
    const e = this.items.get(id);
    return e ? structuredClone(e.item) : undefined;
  }

  async queryItems(q: ItemQuery): Promise<FusionItem[]> {
    let rows = [...this.items.values()].filter(({ item: i }) =>
      (q.claim === undefined || i.claim === q.claim) &&
      (q.kind === undefined || i.kind === q.kind) &&
      (q.sourceType === undefined || i.sourceType === q.sourceType) &&
      gradeOk(i.grade, q.minGrade) &&
      (q.since === undefined || i.at >= q.since) &&
      (q.until === undefined || i.at <= q.until) &&
      (q.hasGeo === undefined || Boolean(i.geo) === q.hasGeo) &&
      inBBox(i.geo, q.bbox) &&
      (q.indicator === undefined || [...i.indicators, ...i.mentions].some(x => `${x.kind}:${x.value}` === q.indicator)),
    );
    if (q.near) {
      const near = q.near;
      rows = rows.map(r => ({ r, s: cosine(r.embedding, near) })).sort((a, b) => b.s - a.s || a.r.item.id.localeCompare(b.r.item.id)).map(x => x.r);
    } else rows.sort((a, b) => b.item.at - a.item.at || a.item.id.localeCompare(b.item.id));
    return rows.slice(0, q.limit ?? 500).map(r => structuredClone(r.item));
  }

  async countItems(): Promise<number> {
    return this.items.size;
  }

  async claims(): Promise<string[]> {
    return [...new Set([...this.items.values()].map(e => e.item.claim).filter((c): c is string => !!c))].sort();
  }

  async putIncident(i: Incident): Promise<void> {
    this.incidents.set(i.id, structuredClone(i));
  }

  async replaceIncidents(kind: Incident['kind'], list: Incident[]): Promise<void> {
    for (const [id, i] of this.incidents) if (i.kind === kind) this.incidents.delete(id);
    for (const i of list) this.incidents.set(i.id, structuredClone(i));
  }

  async queryIncidents(q: IncidentQuery): Promise<Incident[]> {
    return [...this.incidents.values()]
      .filter(i =>
        (q.released === undefined || i.released === q.released) &&
        (q.kind === undefined || i.kind === q.kind) &&
        gradeOk(i.bestGrade, q.minGrade) &&
        // An incident overlaps the window if it started before the end and was last seen after the start.
        (q.since === undefined || i.lastAt >= q.since) &&
        (q.until === undefined || i.firstAt <= q.until) &&
        inBBox(i.geo, q.bbox),
      )
      .sort((a, b) => b.lastAt - a.lastAt || a.id.localeCompare(b.id))
      .map(i => structuredClone(i));
  }

  async heatmap(q: HeatQuery): Promise<HeatCell[]> {
    const cells = new Map<string, HeatCell>();
    for (const { item: i } of this.items.values()) {
      if (!i.geo || (q.kind && i.kind !== q.kind) || (q.proxyOnly && i.meta?.proxy !== true)) continue;
      if ((q.since !== undefined && i.at < q.since) || (q.until !== undefined && i.at > q.until) || !inBBox(i.geo, q.bbox)) continue;
      // Same snapping as PostGIS ST_SnapToGrid: nearest grid point.
      const lat = Math.round(i.geo.lat / q.cell) * q.cell;
      const lon = Math.round(i.geo.lon / q.cell) * q.cell;
      const k = `${lat.toFixed(6)},${lon.toFixed(6)}`;
      const c = cells.get(k) ?? { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)), count: 0 };
      c.count++;
      cells.set(k, c);
    }
    return [...cells.values()].sort((a, b) => b.count - a.count || a.lat - b.lat || a.lon - b.lon);
  }

  async mirrorAudit(r: AuditMirrorRow): Promise<void> {
    this.mirror = this.mirror.filter(x => x.seq !== r.seq);
    this.mirror.push(r);
  }

  async truncateAuditMirror(fromSeq: number): Promise<void> {
    this.mirror = this.mirror.filter(r => r.seq < fromSeq);
  }

  async auditMirror(): Promise<{ count: number; head: string | null }> {
    const last = [...this.mirror].sort((a, b) => a.seq - b.seq).pop();
    return { count: this.mirror.length, head: last?.hash ?? null };
  }
}
