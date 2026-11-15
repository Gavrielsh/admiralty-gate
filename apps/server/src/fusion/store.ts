import { meets, parseGrade } from 'admiralty-gate';
import { cosine } from './embed.js';
import type { AuditMirrorRow, BBox, FusionItem, HeatCell, HeatQuery, Incident, IncidentQuery, ItemQuery, Store } from './types.js';

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

  async init(): Promise<void> {}
  async close(): Promise<void> {}

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
