// The v0.4 pairwise implementation, kept verbatim as the oracle for the parity test. Not part of the library.
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
import { extractEntities, indicatorKey, type Indicator, type IndicatorKind } from '../src/entities.js';
import { checkGeoConsistency, haversineKm, validPoint, type GeoFlag, type GeoPoint, type Place } from '../src/geo.js';
import type { Origin } from '../src/provenance.js';
import { jaccard, shingles } from '../src/text.js';

interface Item {
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

interface ClusterOptions {
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
}

type LinkReason = 'owner' | 'cites' | 'near-duplicate' | 'shared-indicator' | 'burst' | 'proximity';

/** Why two items were judged to share an origin. */
interface ClusterLink {
  a: string;
  b: string;
  reason: LinkReason;
  /** The shared indicators, the time gap, or the distance. */
  detail?: string;
}

interface ClusterResult {
  clusterOf: Map<string, string>;
  clusters: Map<string, string[]>;
  links: ClusterLink[];
  /** Items whose coordinates contradict the place they name or their IP geolocation. */
  geoFlags: Map<string, GeoFlag[]>;
}

class DisjointSet {
  private readonly parent = new Map<string, string>();
  add(x: string): void {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
  find(x: string): string {
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    let c = x;
    while (this.parent.get(c) !== r) {
      const n = this.parent.get(c)!;
      this.parent.set(c, r);
      c = n;
    }
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

function ownerKey(o: Origin, aliases: Record<string, string> = {}): string {
  const raw = (o.owner ?? o.id).toLowerCase();
  return aliases[raw] ?? raw;
}

/** Returns clusterId per item id, and the members per cluster. */
export function clusterItemsReference(items: readonly Item[], opts: ClusterOptions = {}): ClusterResult {
  const links: ClusterLink[] = [];
  const sim = opts.similarity ?? 0.55;
  const k = opts.shingleSize ?? 5;
  const ds = new DisjointSet();
  const sh = new Map<string, Set<string>>();
  const ids = new Set(items.map(i => i.id));
  for (const it of items) {
    ds.add(it.id);
    sh.set(it.id, shingles(it.text, k));
  }

  // 1. Same publisher / owner.
  const byOwner = new Map<string, string>();
  for (const it of items) {
    const key = `${it.origin.kind}:${ownerKey(it.origin, opts.ownerAliases)}`;
    const first = byOwner.get(key);
    if (first) {
      ds.union(first, it.id);
      links.push({ a: first, b: it.id, reason: 'owner', detail: key });
    } else byOwner.set(key, it.id);
  }

  // 2. Explicit citation / forwarding.
  for (const it of items)
    for (const c of it.cites ?? [])
      if (ids.has(c)) {
        ds.union(it.id, c);
        links.push({ a: c, b: it.id, reason: 'cites' });
      }

  // 3. Near-duplicate text.
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      if (ds.find(a.id) === ds.find(b.id)) continue;
      const score = jaccard(sh.get(a.id)!, sh.get(b.id)!);
      if (score >= sim) {
        ds.union(a.id, b.id);
        links.push({ a: a.id, b: b.id, reason: 'near-duplicate', detail: score.toFixed(2) });
      }
    }
  }

  // 4. Shared hard indicators.
  const indOf = new Map<string, Set<string>>();
  const wantInd = opts.indicators || opts.burst;
  if (wantInd) {
    const kinds = opts.indicators?.kinds ? new Set<IndicatorKind>(opts.indicators.kinds) : undefined;
    const holders = new Map<string, number>();
    for (const it of items) {
      const all = [...(it.indicators ?? []), ...(opts.indicators?.fromText ? extractEntities(it.text) : [])];
      const set = new Set(all.filter(i => !kinds || kinds.has(i.kind)).map(indicatorKey));
      indOf.set(it.id, set);
      for (const k of set) holders.set(k, (holders.get(k) ?? 0) + 1);
    }
    // Hub suppression: an indicator on most of the items says nothing about any two of them.
    const cap = items.length >= 4 ? Math.max(2, Math.floor(items.length * (opts.indicators?.maxShare ?? 0.5))) : Infinity;
    for (const set of indOf.values()) for (const k of [...set]) if ((holders.get(k) ?? 0) > cap) set.delete(k);
  }
  const shared = (a: string, b: string): string[] => {
    const x = indOf.get(a);
    const y = indOf.get(b);
    if (!x || !y) return [];
    return [...x].filter(k => y.has(k));
  };
  if (opts.indicators) {
    const need = opts.indicators.minShared ?? 1;
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++) {
        const s = shared(items[i]!.id, items[j]!.id);
        if (s.length >= need) {
          ds.union(items[i]!.id, items[j]!.id);
          links.push({ a: items[i]!.id, b: items[j]!.id, reason: 'shared-indicator', detail: s.slice(0, 5).join(', ') });
        }
      }
  }

  // 5. Temporal burst.
  if (opts.burst) {
    const { windowMs } = opts.burst;
    const needSignal = opts.burst.requireSignal ?? true;
    const minSim = opts.burst.similarity ?? 0.3;
    const timed = items.filter(i => typeof i.at === 'number').sort((a, b) => a.at! - b.at!);
    for (let i = 0; i < timed.length; i++)
      for (let j = i + 1; j < timed.length && timed[j]!.at! - timed[i]!.at! <= windowMs; j++) {
        const a = timed[i]!;
        const b = timed[j]!;
        if (needSignal && shared(a.id, b.id).length === 0 && jaccard(sh.get(a.id)!, sh.get(b.id)!) < minSim) continue;
        ds.union(a.id, b.id);
        links.push({ a: a.id, b: b.id, reason: 'burst', detail: `${Math.round((b.at! - a.at!) / 1000)}s apart` });
      }
  }

  // 6. Spatial proximity.
  if (opts.proximity) {
    const located = items.filter(i => i.geo && validPoint(i.geo));
    for (let i = 0; i < located.length; i++)
      for (let j = i + 1; j < located.length; j++) {
        const a = located[i]!;
        const b = located[j]!;
        const km = haversineKm(a.geo!, b.geo!);
        if (km > opts.proximity.radiusKm) continue;
        if (opts.proximity.windowMs !== undefined) {
          if (typeof a.at !== 'number' || typeof b.at !== 'number' || Math.abs(a.at - b.at) > opts.proximity.windowMs) continue;
        }
        ds.union(a.id, b.id);
        links.push({ a: a.id, b: b.id, reason: 'proximity', detail: `${km.toFixed(1)} km` });
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

  const clusterOf = new Map<string, string>();
  const clusters = new Map<string, string[]>();
  for (const it of items) {
    const root = ds.find(it.id);
    clusterOf.set(it.id, root);
    const arr = clusters.get(root) ?? [];
    arr.push(it.id);
    clusters.set(root, arr);
  }
  return { clusterOf, clusters, links, geoFlags };
}
