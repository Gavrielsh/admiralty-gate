/**
 * PostgreSQL store: PostGIS GEOGRAPHY(Point, 4326) for spatial filters and heatmap bins, pgvector for nearest-text
 * search. Every item's full JSON is kept in `doc`; the typed columns exist to filter and index.
 */
import pg from 'pg';
import { parseGrade } from 'admiralty-gate';
import type { Place } from 'admiralty-gate';
import type { ApprovalRow, ApprovalState, AuditMirrorRow, BBox, CallRow, FusionItem, HeatCell, HeatQuery, Incident, IncidentQuery, IncidentSnapshot, IndicatorGroup, ItemQuery, Store } from './types.js';

const schemaSql = (dim: number): string => `
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
  embedding vector(${dim})
);
CREATE INDEX IF NOT EXISTS fusion_items_geom ON fusion_items USING gist (geom);
CREATE INDEX IF NOT EXISTS fusion_items_claim ON fusion_items (claim);
CREATE INDEX IF NOT EXISTS fusion_items_at ON fusion_items (at);
CREATE INDEX IF NOT EXISTS fusion_items_kind_at ON fusion_items (kind, at);
CREATE INDEX IF NOT EXISTS fusion_items_source ON fusion_items (source_id);
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
);
CREATE TABLE IF NOT EXISTS call_records (id text PRIMARY KEY, at timestamptz NOT NULL, doc jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS call_records_at ON call_records (at DESC);
CREATE TABLE IF NOT EXISTS approvals (
  id text PRIMARY KEY,
  state text NOT NULL,
  requested_at timestamptz NOT NULL,
  doc jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_state ON approvals (state, requested_at DESC);
CREATE TABLE IF NOT EXISTS fusion_incident_history (
  seq bigserial PRIMARY KEY,
  incident_id text NOT NULL,
  at timestamptz NOT NULL,
  doc jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS fusion_incident_history_id ON fusion_incident_history (incident_id, seq);
CREATE TABLE IF NOT EXISTS geocode_cache (query text PRIMARY KEY, place jsonb, cached_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS kv (key text PRIMARY KEY, value text NOT NULL);`;

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

  async init(dim: number): Promise<{ reembed: boolean }> {
    if (!Number.isInteger(dim) || dim < 1 || dim > 2000) throw new Error(`embedding dimension ${dim} is outside what pgvector's HNSW index supports (1-2000)`);
    if (this.schema) await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    await this.pool.query(schemaSql(dim));
    // A different embedding model has a different vector length: old vectors are meaningless to it, so the column
    // is rebuilt and the caller re-embeds every item.
    const cur = await this.pool.query<{ dim: number }>(
      "SELECT a.atttypmod AS dim FROM pg_attribute a WHERE a.attrelid = to_regclass('fusion_items') AND a.attname = 'embedding'",
    );
    if (cur.rows[0] && cur.rows[0].dim !== dim) {
      await this.pool.query('DROP INDEX IF EXISTS fusion_items_embedding');
      await this.pool.query(`ALTER TABLE fusion_items DROP COLUMN embedding, ADD COLUMN embedding vector(${dim})`);
      await this.pool.query('CREATE INDEX IF NOT EXISTS fusion_items_embedding ON fusion_items USING hnsw (embedding vector_cosine_ops)');
      return { reembed: true };
    }
    return { reembed: false };
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

  async getItems(ids: readonly string[]): Promise<FusionItem[]> {
    if (!ids.length) return [];
    const r = await this.pool.query<{ doc: FusionItem }>('SELECT doc FROM fusion_items WHERE id = ANY($1::text[])', [ids]);
    const by = new Map(r.rows.map(x => [x.doc.id, x.doc]));
    return ids.map(i => by.get(i)).filter((x): x is FusionItem => !!x);
  }

  async setEmbedding(id: string, embedding: number[]): Promise<void> {
    await this.pool.query('UPDATE fusion_items SET embedding = $2::vector WHERE id = $1', [id, `[${embedding.join(',')}]`]);
  }

  async pageItems(afterId: string, limit: number): Promise<{ id: string; text: string }[]> {
    return (await this.pool.query<{ id: string; text: string }>("SELECT id, doc->>'text' AS text FROM fusion_items WHERE id > $1 ORDER BY id LIMIT $2", [afterId, limit])).rows;
  }

  async similarPairs(claim: string, minScore: number, limit = 5000): Promise<{ a: string; b: string; score: number }[]> {
    const r = await this.pool.query<{ a: string; b: string; score: number }>(
      `SELECT a.id AS a, b.id AS b, 1 - (a.embedding <=> b.embedding) AS score
       FROM fusion_items a JOIN fusion_items b ON b.claim = a.claim AND a.id < b.id
       WHERE a.claim = $1 AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL AND 1 - (a.embedding <=> b.embedding) >= $2
       ORDER BY a.id, b.id LIMIT $3`,
      [claim, minScore, limit],
    );
    return r.rows.map(x => ({ a: x.a, b: x.b, score: Number(x.score) }));
  }

  /** The grouping, the two-account rule and the hub cap all run in SQL; only linked events come back. */
  async sharedIndicatorGroups(q: { since?: number; kinds: readonly string[]; maxHolders: number }): Promise<IndicatorGroup[]> {
    const r = await this.pool.query<{ key: string; ids: string[] }>(
      `SELECT x.key, array_agg(i.id ORDER BY i.at, i.id) AS ids
       FROM fusion_indicators x JOIN fusion_items i ON i.id = x.item_id
       WHERE x.structural AND i.kind = 'ledger' AND split_part(x.key, ':', 1) = ANY($1::text[]) AND ($2::timestamptz IS NULL OR i.at >= $2)
       GROUP BY x.key
       HAVING count(DISTINCT i.source_id) >= 2 AND count(*) <= $3
       ORDER BY x.key`,
      [q.kinds, q.since === undefined ? null : ts(q.since), q.maxHolders],
    );
    return r.rows.map(x => ({ key: x.key, itemIds: x.ids }));
  }

  async accountEvents(accounts: readonly string[], since?: number): Promise<IndicatorGroup[]> {
    if (!accounts.length) return [];
    const r = await this.pool.query<{ key: string; ids: string[] }>(
      `SELECT source_id AS key, array_agg(id ORDER BY at, id) AS ids FROM fusion_items
       WHERE kind = 'ledger' AND source_id = ANY($1::text[]) AND ($2::timestamptz IS NULL OR at >= $2)
       GROUP BY source_id HAVING count(*) >= 2`,
      [accounts, since === undefined ? null : ts(since)],
    );
    return r.rows.map(x => ({ key: x.key, itemIds: x.ids }));
  }

  /** PostGIS spatial self-join on the geography column (uses the GiST index), restricted by time. */
  async proximityPairs(q: { since?: number; radiusM: number; windowMs: number; limit?: number }): Promise<[string, string][]> {
    const r = await this.pool.query<{ a: string; b: string }>(
      `SELECT a.id AS a, b.id AS b
       FROM fusion_items a JOIN fusion_items b
         ON a.id < b.id AND b.kind = 'ledger' AND a.source_id <> b.source_id
        AND ST_DWithin(a.geom, b.geom, $1)
        AND abs(extract(epoch FROM (a.at - b.at))) * 1000 <= $2
       WHERE a.kind = 'ledger' AND a.geom IS NOT NULL AND b.geom IS NOT NULL
         AND ($3::timestamptz IS NULL OR (a.at >= $3 AND b.at >= $3))
       ORDER BY a.id, b.id LIMIT $4`,
      [q.radiusM, q.windowMs, q.since === undefined ? null : ts(q.since), q.limit ?? 20_000],
    );
    return r.rows.map(x => [x.a, x.b]);
  }

  async countLedger(since?: number): Promise<number> {
    const r = await this.pool.query<{ n: string }>("SELECT count(*) AS n FROM fusion_items WHERE kind = 'ledger' AND ($1::timestamptz IS NULL OR at >= $1)", [since === undefined ? null : ts(since)]);
    return Number(r.rows[0]!.n);
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

  async putCall(row: CallRow): Promise<void> {
    await this.pool.query('INSERT INTO call_records (id, at, doc) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET at = EXCLUDED.at, doc = EXCLUDED.doc', [row.id, ts(row.at), JSON.stringify(row.doc)]);
  }

  async listCalls(limit: number): Promise<CallRow[]> {
    const r = await this.pool.query<{ id: string; at: Date; doc: unknown }>('SELECT id, at, doc FROM call_records ORDER BY at DESC, id DESC LIMIT $1', [limit]);
    return r.rows.map(x => ({ id: x.id, at: x.at.getTime(), doc: x.doc }));
  }

  async putApproval(row: ApprovalRow): Promise<void> {
    await this.pool.query(
      'INSERT INTO approvals (id, state, requested_at, doc) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, doc = EXCLUDED.doc',
      [row.id, row.state, ts(row.requestedAt), JSON.stringify(row)],
    );
  }

  async listApprovals(q: { state?: ApprovalState; limit?: number }): Promise<ApprovalRow[]> {
    const r = await this.pool.query<{ doc: ApprovalRow }>(
      'SELECT doc FROM approvals WHERE ($1::text IS NULL OR state = $1) ORDER BY requested_at DESC, id DESC LIMIT $2',
      [q.state ?? null, q.limit ?? 200],
    );
    return r.rows.map(x => x.doc);
  }

  async expirePendingApprovals(note: string, at: number): Promise<number> {
    const r = await this.pool.query(
      `UPDATE approvals SET state = 'expired', doc = doc || jsonb_build_object('state', 'expired', 'resolvedAt', $2::bigint, 'note', $1::text) WHERE state = 'pending'`,
      [note, at],
    );
    return r.rowCount ?? 0;
  }

  async appendIncidentHistory(id: string, s: IncidentSnapshot): Promise<void> {
    await this.pool.query('INSERT INTO fusion_incident_history (incident_id, at, doc) VALUES ($1,$2,$3)', [id, ts(s.at), JSON.stringify(s)]);
  }

  async incidentHistory(id: string): Promise<IncidentSnapshot[]> {
    return (await this.pool.query<{ doc: IncidentSnapshot }>('SELECT doc FROM fusion_incident_history WHERE incident_id = $1 ORDER BY seq', [id])).rows.map(x => x.doc);
  }

  async getGeocode(query: string): Promise<{ hit: boolean; place?: Place }> {
    const r = await this.pool.query<{ place: Place | null }>('SELECT place FROM geocode_cache WHERE query = $1', [query]);
    if (!r.rows[0]) return { hit: false };
    return r.rows[0].place ? { hit: true, place: r.rows[0].place } : { hit: true };
  }

  async putGeocode(query: string, place: Place | undefined): Promise<void> {
    await this.pool.query('INSERT INTO geocode_cache (query, place) VALUES ($1,$2) ON CONFLICT (query) DO UPDATE SET place = EXCLUDED.place, cached_at = now()', [query, place ? JSON.stringify(place) : null]);
  }

  async getKv(key: string): Promise<string | undefined> {
    return (await this.pool.query<{ value: string }>('SELECT value FROM kv WHERE key = $1', [key])).rows[0]?.value;
  }

  async putKv(key: string, value: string): Promise<void> {
    await this.pool.query('INSERT INTO kv (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
  }
}
