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
 */
import type { Origin } from './provenance.js';
import { jaccard, shingles } from './text.js';

export interface Item {
  id: string;
  text: string;
  origin: Origin;
  /** Ids of items this one republishes, forwards or cites. */
  cites?: string[];
}

export interface ClusterOptions {
  /** Near-duplicate threshold on shingle Jaccard. Default 0.55. */
  similarity?: number;
  shingleSize?: number;
  /** Extra owner aliases, e.g. {"aljazeera.net": "aljazeera"}. */
  ownerAliases?: Record<string, string>;
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

export function ownerKey(o: Origin, aliases: Record<string, string> = {}): string {
  const raw = (o.owner ?? o.id).toLowerCase();
  return aliases[raw] ?? raw;
}

/** Returns clusterId per item id, and the members per cluster. */
export function clusterItems(
  items: readonly Item[],
  opts: ClusterOptions = {},
): { clusterOf: Map<string, string>; clusters: Map<string, string[]> } {
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
    if (first) ds.union(first, it.id);
    else byOwner.set(key, it.id);
  }

  // 2. Explicit citation / forwarding.
  for (const it of items) for (const c of it.cites ?? []) if (ids.has(c)) ds.union(it.id, c);

  // 3. Near-duplicate text.
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      if (ds.find(a.id) === ds.find(b.id)) continue;
      if (jaccard(sh.get(a.id)!, sh.get(b.id)!) >= sim) ds.union(a.id, b.id);
    }
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
  return { clusterOf, clusters };
}
