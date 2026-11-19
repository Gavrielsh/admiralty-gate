/**
 * Independence clustering.
 *
 * Ten Telegram channels reposting one wire story are ONE source, not ten.
 * Counting them separately is the classic way an OSINT pipeline manufactures
 * false confidence, and it is exactly what an adversary amplifying a
 * narrative wants. Items are merged into one independence cluster when they
 *   - share a publisher/owner id,
 *   - explicitly cite one another (forwarded-from, "via", quote-of),
 *   - or are near-duplicate text (k-word shingle Jaccard above a threshold).
 *
 * Merging is transitive (union-find), so A~B and B~C puts all three together.
 *
 * Optional rules for coordinated networks and fraud rings (all OFF unless
 * their option is set, so existing callers see no change):
 *   - shared hard indicators (same IP, wallet, device, Telegram channel ...),
 *   - temporal bursts (synchronised posts or transactions inside a window),
 *   - spatial proximity (events within a radius, optionally also in time).
 * Every rule can only MERGE clusters. Merging lowers the independent-source
 * count, so a wrong merge costs confidence, never inflates it.
 */
import { extractEntities, indicatorKey, type Indicator, type IndicatorKind } from './entities.js';
import { checkGeoConsistency, haversineKm, validPoint, type GeoFlag, type GeoPoint, type Place } from './geo.js';
import type { Origin } from './provenance.js';
import { jaccard, shingles } from './text.js';

export interface Item {
  id: string;
  text: string;
  origin: Origin;
  /** Ids of items this one republishes, forwards or cites. */
  cites?: string[];
  /** Indicators describing who PRODUCED the item (session IP, wallet, device, forwarding channel). */
  indicators?: readonly Indicator[];
  /** When the item was published or the event happened (ms since epoch). */
  at?: number;
  /** Where the item says it happened (resolved coordinates). */
  geo?: GeoPoint;
  /** The place the item names, if stated separately from its text. */
  claimedPlace?: string;
  /** Where IP geolocation puts the item's producer. */
  ipGeo?: GeoPoint;
}

export interface ClusterOptions {
  /** Near-duplicate threshold on shingle Jaccard. Default 0.55. */
  similarity?: number;
  shingleSize?: number;
  /** Extra owner aliases, e.g. {"aljazeera.net": "aljazeera"}. */
  ownerAliases?: Record<string, string>;
  /** Merge items that share hard indicators. */
  indicators?: {
    /** Shared indicators needed to link two items. Default 1. */
    minShared?: number;
    /** Indicator kinds that count. Default: all. */
    kinds?: readonly IndicatorKind[];
    /**
     * Also use indicators merely MENTIONED in the text. Default false: outlets reporting on the same IP all mention
     * it without being one source. Turn on for material where a mention is itself the link (scam posts, lures).
     */
    fromText?: boolean;
    /**
     * Ignore an indicator carried by more than this share of the items (a CGNAT address, a big exchange wallet):
     * it would otherwise weld everything together. Applies from 4 items up. Default 0.5.
     */
    maxShare?: number;
  };
  /** Merge items published inside one time window. */
  burst?: {
    windowMs: number;
    /**
     * Require a second signal besides timing: a shared indicator or text similarity >= `similarity`. Default true,
     * because independent outlets legitimately report the same event within minutes. Set false for streams where
     * synchrony alone is the anomaly (transaction bursts).
     */
    requireSignal?: boolean;
    /** Text similarity that counts as the second signal. Default 0.3. */
    similarity?: number;
  };
  /** Merge items located within a radius (and, if given, a time window) of each other. */
  proximity?: { radiusKm: number; windowMs?: number };
  /** Gazetteer and tolerances for the coordinate / place-name consistency check. */
  gazetteer?: readonly Place[];
  geoToleranceKm?: number;
  ipGeoToleranceKm?: number;
  /**
   * Semantic similarity computed OUTSIDE the core (embeddings, a vector index) and handed in as scored pairs. Use it
   * for translated or paraphrased copies that share no wording. Keep the threshold high and prefer `withinMs`:
   * two independent outlets reporting one event are also semantically similar, and they must stay independent.
   */
  semantic?: { pairs: readonly { a: string; b: string; score: number }[]; threshold?: number; withinMs?: number };
}

export type LinkReason = 'owner' | 'cites' | 'near-duplicate' | 'shared-indicator' | 'burst' | 'proximity' | 'semantic';

/** Why two items were judged to share an origin. */
export interface ClusterLink {
  a: string;
  b: string;
  reason: LinkReason;
  /** The shared indicators, the time gap, or the distance. */
  detail?: string;
}

export interface ClusterResult {
  clusterOf: Map<string, string>;
  clusters: Map<string, string[]>;
  links: ClusterLink[];
  /** Items whose coordinates contradict the place they name or their IP geolocation. */
  geoFlags: Map<string, GeoFlag[]>;
}

/** Union-find over item indices, with path halving and union by size. */
class DisjointSet {
  private readonly parent: Int32Array;
  private readonly size: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    this.size = new Int32Array(n).fill(1);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(x: number): number {
    const p = this.parent;
    while (p[x] !== x) {
      p[x] = p[p[x]!]!;
      x = p[x]!;
    }
    return x;
  }
  union(a: number, b: number): void {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return;
    if (this.size[ra]! < this.size[rb]!) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    this.size[ra]! += this.size[rb]!;
  }
}

export function ownerKey(o: Origin, aliases: Record<string, string> = {}): string {
  const raw = (o.owner ?? o.id).toLowerCase();
  return aliases[raw] ?? raw;
}

/** Returns clusterId per item id, and the members per cluster. */
/** A posting list up to this size reports every linked pair; a larger one reports a chain that connects it. */
const PAIR_LINK_CAP = 64;

/**
 * Exact set-similarity join (prefix filtering): calls `visit` for every pair of sets whose Jaccard similarity is at
 * least `t`, without comparing every pair. Tokens are ordered rarest first; two sets that similar must share a token
 * within their first |x| - ceil(t|x|) + 1 tokens, so only those prefixes are indexed.
 */
function similarityJoin(sets: readonly (ReadonlySet<string> | undefined)[], t: number, skip: (i: number, j: number) => boolean, visit: (i: number, j: number, score: number) => void): void {
  const freq = new Map<string, number>();
  for (const s of sets) if (s) for (const tok of s) freq.set(tok, (freq.get(tok) ?? 0) + 1);
  const index = new Map<string, number[]>();
  const stamp = new Int32Array(sets.length).fill(-1);
  for (let i = 0; i < sets.length; i++) {
    const s = sets[i];
    if (!s || s.size === 0) continue;
    const ordered = [...s].sort((a, b) => freq.get(a)! - freq.get(b)! || (a < b ? -1 : a > b ? 1 : 0));
    const prefix = Math.min(ordered.length, ordered.length - Math.ceil(t * ordered.length) + 1);
    for (let p = 0; p < prefix; p++) {
      const list = index.get(ordered[p]!);
      if (!list) continue;
      for (const j of list) {
        if (stamp[j] === i) continue;
        stamp[j] = i;
        if (skip(i, j)) continue;
        const o = sets[j]!;
        const [small, large] = s.size <= o.size ? [s, o] : [o, s];
        if (small.size < t * large.size) continue;
        let inter = 0;
        for (const x of small) if (large.has(x)) inter++;
        const score = inter / (s.size + o.size - inter);
        if (score >= t) visit(j, i, score);
      }
    }
    for (let p = 0; p < prefix; p++) {
      const tok = ordered[p]!;
      const list = index.get(tok);
      if (list) list.push(i);
      else index.set(tok, [i]);
    }
  }
}

/**
 * Independence clustering. Candidate pairs come from inverted indexes (owner, shingle prefixes, indicator postings),
 * a time-sorted sweep and a spatial grid, so the cost grows with the number of items and the size of the groups
 * they form rather than with the square of the input. The resulting partition is the same as comparing every pair.
 * `links` lists the pairs that were examined and found linked: all of them for small groups, a connecting chain for
 * groups larger than 64.
 */
export function clusterItems(items: readonly Item[], opts: ClusterOptions = {}): ClusterResult {
  const links: ClusterLink[] = [];
  const sim = opts.similarity ?? 0.55;
  const k = opts.shingleSize ?? 5;
  const n = items.length;
  const ds = new DisjointSet(n);
  const id = (i: number): string => items[i]!.id;
  const indexOf = new Map<string, number>();
  items.forEach((it, i) => indexOf.set(it.id, i));
  const same = (i: number, j: number): boolean => ds.find(i) === ds.find(j);

  // 1. Same publisher / owner.
  const byOwner = new Map<string, number>();
  items.forEach((it, i) => {
    const key = `${it.origin.kind}:${ownerKey(it.origin, opts.ownerAliases)}`;
    const first = byOwner.get(key);
    if (first !== undefined) {
      ds.union(first, i);
      links.push({ a: id(first), b: it.id, reason: 'owner', detail: key });
    } else byOwner.set(key, i);
  });

  // 2. Explicit citation / forwarding.
  items.forEach((it, i) => {
    for (const c of it.cites ?? []) {
      const j = indexOf.get(c);
      if (j === undefined) continue;
      ds.union(i, j);
      links.push({ a: c, b: it.id, reason: 'cites' });
    }
  });

  // Shingles are only computed when a rule needs text (they dominate the cost on large inputs).
  const burstNeedsText = !!opts.burst && (opts.burst.requireSignal ?? true) && (opts.burst.similarity ?? 0.3) <= 1;
  const sh: (Set<string> | undefined)[] = sim <= 1 || burstNeedsText ? items.map(it => shingles(it.text, k)) : [];
  const empties: number[] = [];
  sh.forEach((s, i) => s && s.size === 0 && empties.push(i));

  // 3. Near-duplicate text.
  if (sim <= 1) {
    const hit = (i: number, j: number, score: number) => {
      if (same(i, j)) return;
      ds.union(i, j);
      links.push({ a: id(i), b: id(j), reason: 'near-duplicate', detail: score.toFixed(2) });
    };
    // Two texts with nothing to shingle count as identical, as before.
    for (let e = 1; e < empties.length; e++) hit(empties[e - 1]!, empties[e]!, 1);
    if (sim <= 0) for (let i = 1; i < n; i++) hit(i - 1, i, 0);
    else similarityJoin(sh, sim, same, hit);
  }

  // 4. Shared hard indicators: one posting list per indicator.
  const indOf: Set<string>[] = [];
  const postings = new Map<string, number[]>();
  if (opts.indicators || opts.burst) {
    const kinds = opts.indicators?.kinds ? new Set<IndicatorKind>(opts.indicators.kinds) : undefined;
    const holders = new Map<string, number>();
    for (const it of items) {
      const all = [...(it.indicators ?? []), ...(opts.indicators?.fromText ? extractEntities(it.text) : [])];
      const set = new Set(all.filter(i => !kinds || kinds.has(i.kind)).map(indicatorKey));
      indOf.push(set);
      for (const key of set) holders.set(key, (holders.get(key) ?? 0) + 1);
    }
    // Hub suppression: an indicator on most of the items says nothing about any two of them.
    const cap = n >= 4 ? Math.max(2, Math.floor(n * (opts.indicators?.maxShare ?? 0.5))) : Infinity;
    indOf.forEach((set, i) => {
      for (const key of [...set]) {
        if ((holders.get(key) ?? 0) > cap) set.delete(key);
        else if ((holders.get(key) ?? 0) > 1) {
          const list = postings.get(key);
          if (list) list.push(i);
          else postings.set(key, [i]);
        }
      }
    });
  }
  if (opts.indicators) {
    const need = opts.indicators.minShared ?? 1;
    const pairs = new Map<number, string[]>();
    const chains: ClusterLink[] = [];
    for (const [key, list] of postings) {
      if (need <= 1 && list.length > PAIR_LINK_CAP) {
        for (let x = 1; x < list.length; x++) {
          ds.union(list[x - 1]!, list[x]!);
          chains.push({ a: id(list[x - 1]!), b: id(list[x]!), reason: 'shared-indicator', detail: key });
        }
        continue;
      }
      // Small group (or minShared > 1, which has to count per pair): every pair in the posting.
      for (let x = 0; x < list.length; x++)
        for (let y = x + 1; y < list.length; y++) {
          const pk = list[x]! * n + list[y]!;
          const keys = pairs.get(pk);
          if (keys) keys.push(key);
          else pairs.set(pk, [key]);
        }
    }
    for (const pk of [...pairs.keys()].sort((a, b) => a - b)) {
      const keys = pairs.get(pk)!;
      if (keys.length < need) continue;
      const i = Math.floor(pk / n);
      const j = pk % n;
      ds.union(i, j);
      // Same order the indicators appear on the first item, as the pairwise implementation reported them.
      const detail = [...indOf[i]!].filter(x => indOf[j]!.has(x)).slice(0, 5).join(', ');
      links.push({ a: id(i), b: id(j), reason: 'shared-indicator', detail });
    }
    links.push(...chains);
  }

  // 5. Temporal burst: a sweep over time-sorted items instead of every pair inside the window.
  if (opts.burst) {
    const { windowMs } = opts.burst;
    const needSignal = opts.burst.requireSignal ?? true;
    const minSim = opts.burst.similarity ?? 0.3;
    const at = (i: number): number => items[i]!.at as number;
    const timed = (i: number): boolean => typeof items[i]!.at === 'number';
    const byTime = (a: number, b: number): number => at(a) - at(b) || a - b;
    const burst = (i: number, j: number) => {
      const [a, b] = at(i) <= at(j) ? [i, j] : [j, i];
      ds.union(a, b);
      links.push({ a: id(a), b: id(b), reason: 'burst', detail: `${Math.round((at(b) - at(a)) / 1000)}s apart` });
    };
    /** Link neighbours in time within a group whose members are all mutually eligible. */
    const sweep = (group: number[]) => {
      const g = group.filter(timed).sort(byTime);
      for (let x = 1; x < g.length; x++) if (at(g[x]!) - at(g[x - 1]!) <= windowMs && !same(g[x - 1]!, g[x]!)) burst(g[x - 1]!, g[x]!);
    };
    if (!needSignal) sweep(items.map((_, i) => i));
    else {
      // Signal 1: a shared indicator. Within one posting list, neighbours in time are enough.
      for (const list of postings.values()) sweep(list);
      // Signal 2: similar text.
      if (minSim <= 1) {
        sweep(empties);
        const eligible = sh.map((s, i) => (timed(i) ? s : undefined));
        if (minSim <= 0) sweep(items.map((_, i) => i));
        else similarityJoin(eligible, minSim, (i, j) => Math.abs(at(i) - at(j)) > windowMs || same(i, j), (i, j) => burst(i, j));
      }
    }
  }

  // 6. Spatial proximity: a grid on the unit sphere; only neighbouring cells are compared.
  if (opts.proximity) {
    const { radiusKm, windowMs } = opts.proximity;
    const located: number[] = [];
    items.forEach((it, i) => it.geo && validPoint(it.geo) && located.push(i));
    const near = (i: number, j: number, km: number) => {
      ds.union(i, j);
      links.push({ a: id(i), b: id(j), reason: 'proximity', detail: `${km.toFixed(1)} km` });
    };
    const inWindow = (i: number, j: number): boolean =>
      windowMs === undefined || (typeof items[i]!.at === 'number' && typeof items[j]!.at === 'number' && Math.abs((items[i]!.at as number) - (items[j]!.at as number)) <= windowMs);
    // Without a time window, points at exactly the same coordinates are one group: keep one of them for the grid.
    let reps = located;
    if (windowMs === undefined) {
      const seen = new Map<string, number>();
      reps = [];
      for (const i of located) {
        const g = items[i]!.geo!;
        const key = `${g.lat},${g.lon}`;
        const first = seen.get(key);
        if (first === undefined) {
          seen.set(key, i);
          reps.push(i);
        } else if (radiusKm >= 0) near(first, i, 0);
      }
    }
    // Chord length for the radius; padded so rounding can only add candidates (each is verified by haversine).
    const cell = Math.max(1e-9, 2 * Math.sin(Math.min(Math.PI, radiusKm / 6371.0088) / 2) * 1.0001);
    // Cell coordinates are hashed to one integer. A collision only adds candidates; every candidate is verified.
    const grid = new Map<number, number[]>();
    const cellKey = (x: number, y: number, z: number): number => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) | 0;
    const xyz = (g: GeoPoint): [number, number, number] => {
      const la = (g.lat * Math.PI) / 180;
      const lo = (g.lon * Math.PI) / 180;
      return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    };
    for (const i of reps) {
      const [x, y, z] = xyz(items[i]!.geo!);
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      const cz = Math.floor(z / cell);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const bucket = grid.get(cellKey(cx + dx, cy + dy, cz + dz));
            if (!bucket) continue;
            for (const j of bucket) {
              if (same(i, j) || !inWindow(i, j)) continue;
              const km = haversineKm(items[j]!.geo!, items[i]!.geo!);
              if (km <= radiusKm) near(j, i, km);
            }
          }
      const key = cellKey(cx, cy, cz);
      const bucket = grid.get(key);
      if (bucket) bucket.push(i);
      else grid.set(key, [i]);
    }
  }

  // 7. Semantic similarity supplied by the caller (the core computes no embeddings).
  if (opts.semantic) {
    const thr = opts.semantic.threshold ?? 0.92;
    for (const p of opts.semantic.pairs) {
      const i = indexOf.get(p.a);
      const j = indexOf.get(p.b);
      if (i === undefined || j === undefined || i === j || !(p.score >= thr)) continue;
      const a = items[i]!;
      const b = items[j]!;
      if (opts.semantic.withinMs !== undefined && !(typeof a.at === 'number' && typeof b.at === 'number' && Math.abs(a.at - b.at) <= opts.semantic.withinMs)) continue;
      if (same(i, j)) continue;
      ds.union(i, j);
      links.push({ a: a.id, b: b.id, reason: 'semantic', detail: p.score.toFixed(2) });
    }
  }

  // Coordinate vs. place-name / IP-geolocation consistency (a flag, never a merge).
  const geoFlags = new Map<string, GeoFlag[]>();
  for (const it of items) {
    if (!it.geo) continue;
    const f = checkGeoConsistency(
      { point: it.geo, text: it.text, ...(it.claimedPlace ? { claimedPlace: it.claimedPlace } : {}), ...(it.ipGeo ? { ipGeo: it.ipGeo } : {}) },
      {
        ...(opts.gazetteer ? { gazetteer: opts.gazetteer } : {}),
        ...(opts.geoToleranceKm !== undefined ? { toleranceKm: opts.geoToleranceKm } : {}),
        ...(opts.ipGeoToleranceKm !== undefined ? { ipToleranceKm: opts.ipGeoToleranceKm } : {}),
      },
    );
    if (f.length) geoFlags.set(it.id, f);
  }

  // A cluster is named after its first member, so the name does not depend on the order unions happened in.
  const clusterOf = new Map<string, string>();
  const clusters = new Map<string, string[]>();
  const name = new Map<number, string>();
  items.forEach((it, i) => {
    const root = ds.find(i);
    let label = name.get(root);
    if (label === undefined) {
      label = it.id;
      name.set(root, label);
      clusters.set(label, []);
    }
    clusterOf.set(it.id, label);
    clusters.get(label)!.push(it.id);
  });
  return { clusterOf, clusters, links, geoFlags };
}
