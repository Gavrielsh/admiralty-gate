/**
 * PostgreSQL store: PostGIS GEOGRAPHY(Point, 4326) for spatial filters and heatmap bins, pgvector for nearest-text
 * search. Every item's full JSON is kept in `doc`; the typed columns exist to filter and index.
 */
import pg from 'pg';
import { parseGrade } from 'admiralty-gate';
import { EMBED_DIM } from './embed.js';
import type { AuditMirrorRow, BBox, FusionItem, HeatCell, HeatQuery, Incident, IncidentQuery, ItemQuery, Store } from './types.js';

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS fusion_items (
  id text PRIMARY KEY,
  hash text UNIQUE NOT NULL,
  kind text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  grade_r char(1) NOT NULL,
  grade_c smallint NOT NULL,
  at timestamptz NOT NULL,
  claim text,
  proxy boolean NOT NULL DEFAULT false,
  doc jsonb NOT NULL,
  geom geography(Point, 4326),
  embedding vector(${EMBED_DIM})
);
CREATE INDEX IF NOT EXISTS fusion_items_geom ON fusion_items USING gist (geom);
CREATE INDEX IF NOT EXISTS fusion_items_claim ON fusion_items (claim);
CREATE INDEX IF NOT EXISTS fusion_items_at ON fusion_items (at);
CREATE INDEX IF NOT EXISTS fusion_items_embedding ON fusion_items USING hnsw (embedding vector_cosine_ops);
CREATE TABLE IF NOT EXISTS fusion_indicators (
  item_id text NOT NULL REFERENCES fusion_items (id) ON DELETE CASCADE,
  key text NOT NULL,
  structural boolean NOT NULL,
  PRIMARY KEY (item_id, key, structural)
);
CREATE INDEX IF NOT EXISTS fusion_indicators_key ON fusion_indicators (key);
CREATE TABLE IF NOT EXISTS fusion_incidents (
  id text PRIMARY KEY,
  kind text NOT NULL,
  released boolean NOT NULL,
  best_r char(1),
  best_c smallint,
  first_at timestamptz NOT NULL,
  last_at timestamptz NOT NULL,
  doc jsonb NOT NULL,
  geom geography(Point, 4326)
);
CREATE INDEX IF NOT EXISTS fusion_incidents_geom ON fusion_incidents USING gist (geom);
CREATE TABLE IF NOT EXISTS audit_mirror (
  seq integer PRIMARY KEY,
  hash text NOT NULL,
  prev text NOT NULL,
  kind text NOT NULL,
  at timestamptz NOT NULL,
  data jsonb
);`;

const point = (g: { lat: number; lon: number } | undefined): string | null => (g ? `SRID=4326;POINT(${g.lon} ${g.lat})` : null);
const ts = (ms: number): Date => new Date(ms);

/** WHERE-clause builder with numbered parameters. */
class Where {
  readonly parts: string[] = [];
  readonly params: unknown[] = [];
  add(sql: string, ...values: unknown[]): void {
    let s = sql;
    for (const v of values) {
      this.params.push(v);
      s = s.replace('?', `$${this.params.length}`);
    }
    this.parts.push(s);
  }
  bbox(col: string, b: BBox | undefined): void {
    if (b) this.add(`ST_Covers(ST_MakeEnvelope(?, ?, ?, ?, 4326), ${col}::geometry)`, b[0], b[1], b[2], b[3]);
  }
  grade(r: string, c: string, min: string | undefined): void {
    if (!min) return;
    const g = parseGrade(min);
    this.add(`${r} <= ? AND ${c} <= ?`, g.r, g.c);
  }
  get sql(): string {
    return this.parts.length ? `WHERE ${this.parts.join(' AND ')}` : '';
  }
}

export class PgStore implements Store {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;

  /** `schema` isolates a test run; production uses the default search path. */
  constructor(connectionString: string, private readonly schema?: string) {
    this.pool = new pg.Pool({ connectionString, max: 8, ...(schema ? { options: `-c search_path=${schema},public` } : {}) });
  }

  async init(): Promise<void> {
    if (this.schema) await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    await this.pool.query(SCHEMA);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Test helper: remove an isolated schema. Refuses to touch the default schema. */
  async dropSchema(): Promise<void> {
    if (!this.schema) throw new Error('refusing to drop the default schema');
    await this.pool.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`);
  }

  async putItem(item: FusionItem, embedding: number[]): Promise<boolean> {
    const g = parseGrade(item.grade);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `INSERT INTO fusion_items (id, hash, kind, source_type, source_id, grade_r, grade_c, at, claim, proxy, doc, geom, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::geography,$13::vector) ON CONFLICT DO NOTHING`,
        [item.id, item.hash, item.kind, item.sourceType, item.sourceId, g.r, g.c, ts(item.at), item.claim ?? null, item.meta?.proxy === true,
          JSON.stringify(item), point(item.geo), `[${embedding.join(',')}]`],
      );
      const inserted = r.rowCount === 1;
      if (inserted) {
        const keys = [
          ...item.indicators.map(i => [`${i.kind}:${i.value}`, true] as const),
          ...item.mentions.map(i => [`${i.kind}:${i.value}`, false] as const),
        ];
        for (const [key, structural] of keys)
          await client.query('INSERT INTO fusion_indicators (item_id, key, structural) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [item.id, key, structural]);
      }
      await client.query('COMMIT');
      return inserted;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async updateItem(id: string, patch: Partial<FusionItem>): Promise<void> {
    const cur = await this.getItem(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    await this.pool.query('UPDATE fusion_items SET doc = $2, geom = $3::geography WHERE id = $1', [id, JSON.stringify(next), point(next.geo)]);
  }

  async getItem(id: string): Promise<FusionItem | undefined> {
    const r = await this.pool.query<{ doc: FusionItem }>('SELECT doc FROM fusion_items WHERE id = $1', [id]);
    return r.rows[0]?.doc;
  }

  async queryItems(q: ItemQuery): Promise<FusionItem[]> {
    const w = new Where();
    if (q.claim !== undefined) w.add('claim = ?', q.claim);
    if (q.kind) w.add('kind = ?', q.kind);
    if (q.sourceType) w.add('source_type = ?', q.sourceType);
    w.grade('grade_r', 'grade_c', q.minGrade);
    if (q.since !== undefined) w.add('at >= ?', ts(q.since));
    if (q.until !== undefined) w.add('at <= ?', ts(q.until));
    if (q.hasGeo !== undefined) w.parts.push(q.hasGeo ? 'geom IS NOT NULL' : 'geom IS NULL');
    w.bbox('geom', q.bbox);
    if (q.indicator) w.add('EXISTS (SELECT 1 FROM fusion_indicators x WHERE x.item_id = fusion_items.id AND x.key = ?)', q.indicator);
    let order = 'at DESC, id';
    if (q.near) {
      w.params.push(`[${q.near.join(',')}]`);
      order = `embedding <=> $${w.params.length}::vector, id`;
    }
    w.params.push(q.limit ?? 500);
    const r = await this.pool.query<{ doc: FusionItem }>(`SELECT doc FROM fusion_items ${w.sql} ORDER BY ${order} LIMIT $${w.params.length}`, w.params);
    return r.rows.map(x => x.doc);
  }

  async countItems(): Promise<number> {
    return Number((await this.pool.query<{ n: string }>('SELECT count(*) AS n FROM fusion_items')).rows[0]!.n);
  }

  async claims(): Promise<string[]> {
    return (await this.pool.query<{ claim: string }>('SELECT DISTINCT claim FROM fusion_items WHERE claim IS NOT NULL ORDER BY claim')).rows.map(r => r.claim);
  }

  private incidentRow(i: Incident): unknown[] {
    const g = i.bestGrade ? parseGrade(i.bestGrade) : undefined;
    return [i.id, i.kind, i.released, g?.r ?? null, g?.c ?? null, ts(i.firstAt), ts(i.lastAt), JSON.stringify(i), point(i.geo)];
  }

  private static readonly UPSERT_INCIDENT = `INSERT INTO fusion_incidents (id, kind, released, best_r, best_c, first_at, last_at, doc, geom)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::geography)
    ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, released = EXCLUDED.released, best_r = EXCLUDED.best_r, best_c = EXCLUDED.best_c,
      first_at = EXCLUDED.first_at, last_at = EXCLUDED.last_at, doc = EXCLUDED.doc, geom = EXCLUDED.geom`;

  async putIncident(i: Incident): Promise<void> {
    await this.pool.query(PgStore.UPSERT_INCIDENT, this.incidentRow(i));
  }

  async replaceIncidents(kind: Incident['kind'], list: Incident[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM fusion_incidents WHERE kind = $1', [kind]);
      for (const i of list) await client.query(PgStore.UPSERT_INCIDENT, this.incidentRow(i));
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async queryIncidents(q: IncidentQuery): Promise<Incident[]> {
    const w = new Where();
    if (q.released !== undefined) w.add('released = ?', q.released);
    if (q.kind) w.add('kind = ?', q.kind);
    w.grade('best_r', 'best_c', q.minGrade);
    if (q.since !== undefined) w.add('last_at >= ?', ts(q.since));
    if (q.until !== undefined) w.add('first_at <= ?', ts(q.until));
    w.bbox('geom', q.bbox);
    const r = await this.pool.query<{ doc: Incident }>(`SELECT doc FROM fusion_incidents ${w.sql} ORDER BY last_at DESC, id`, w.params);
    return r.rows.map(x => x.doc);
  }

  async heatmap(q: HeatQuery): Promise<HeatCell[]> {
    const w = new Where();
    w.parts.push('geom IS NOT NULL');
    if (q.kind) w.add('kind = ?', q.kind);
    if (q.proxyOnly) w.parts.push('proxy');
    if (q.since !== undefined) w.add('at >= ?', ts(q.since));
    if (q.until !== undefined) w.add('at <= ?', ts(q.until));
    w.bbox('geom', q.bbox);
    w.params.push(q.cell);
    const r = await this.pool.query<{ lat: number; lon: number; count: string }>(
      `SELECT ST_Y(c) AS lat, ST_X(c) AS lon, count(*) AS count
       FROM (SELECT ST_SnapToGrid(geom::geometry, $${w.params.length}::float8) AS c FROM fusion_items ${w.sql}) s
       GROUP BY c ORDER BY count(*) DESC, ST_Y(c), ST_X(c)`,
      w.params,
    );
    return r.rows.map(x => ({ lat: Number(Number(x.lat).toFixed(6)), lon: Number(Number(x.lon).toFixed(6)), count: Number(x.count) }));
  }

  async mirrorAudit(r: AuditMirrorRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_mirror (seq, hash, prev, kind, at, data) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (seq) DO UPDATE SET hash = EXCLUDED.hash, prev = EXCLUDED.prev, kind = EXCLUDED.kind, at = EXCLUDED.at, data = EXCLUDED.data`,
      [r.seq, r.hash, r.prev, r.kind, ts(r.at), JSON.stringify(r.data ?? null)],
    );
  }

  async truncateAuditMirror(fromSeq: number): Promise<void> {
    await this.pool.query('DELETE FROM audit_mirror WHERE seq >= $1', [fromSeq]);
  }

  async auditMirror(): Promise<{ count: number; head: string | null }> {
    const r = await this.pool.query<{ n: string; head: string | null }>(
      'SELECT count(*) AS n, (SELECT hash FROM audit_mirror ORDER BY seq DESC LIMIT 1) AS head FROM audit_mirror',
    );
    return { count: Number(r.rows[0]!.n), head: r.rows[0]!.head };
  }
}
