import { describe, expect, it } from 'vitest';
import { ProvenanceLedger, clusterItems, groundReport, type ClusterOptions, type Item } from '../src/index.js';
import { clusterItemsReference } from './reference-cluster.js';

/** Deterministic PRNG (mulberry32), so a failure is reproducible from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = 'port strike union workers cargo vessel anchor explosion refinery harbour fire police report sources confirm deny minister statement night morning'.split(' ');
const CENTRES = [[34.68, 33.04], [35.17, 33.36], [32.81, 34.99], [14.5, 42.3], [-33.9, 151.2], [89.9, 10], [0, 179.99], [0, -179.99]] as const;

function randomItems(r: () => number, n: number): Item[] {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const sentence = (len: number) => Array.from({ length: len }, () => pick(WORDS)).join(' ');
  const base = Array.from({ length: Math.max(2, Math.floor(n / 6)) }, () => sentence(8 + Math.floor(r() * 10)));
  return Array.from({ length: n }, (_, i): Item => {
    const roll = r();
    // A third are copies of a base text with a small edit; some are empty or very short; the rest are fresh.
    const text = roll < 0.35 ? `${pick(base)} ${pick(WORDS)}` : roll < 0.4 ? '' : roll < 0.45 ? pick(WORDS) : sentence(6 + Math.floor(r() * 12));
    const c = pick(CENTRES);
    return {
      id: `i${i}`,
      text,
      origin: { id: `src-${Math.floor(r() * n * 0.8)}`, kind: r() < 0.5 ? 'telegram' : 'feed', ...(r() < 0.1 ? { owner: `owner-${Math.floor(r() * 4)}` } : {}) },
      ...(r() < 0.15 && i > 0 ? { cites: [`i${Math.floor(r() * i)}`, 'missing'] } : {}),
      ...(r() < 0.6 ? { indicators: Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({ kind: pick(['wallet', 'device', 'ip'] as const), value: `v${Math.floor(r() * n * 0.7)}` })) } : {}),
      ...(r() < 0.8 ? { at: 1_700_000_000_000 + Math.floor(r() * 3_600_000) } : {}),
      ...(r() < 0.7 ? { geo: { lat: Math.max(-90, Math.min(90, c[0] + (r() - 0.5) * 0.08)), lon: c[1] + (r() - 0.5) * 0.08 > 180 ? 180 : Math.max(-180, c[1] + (r() - 0.5) * 0.08) } } : {}),
    };
  });
}

function randomOptions(r: () => number): ClusterOptions {
  const o: ClusterOptions = {};
  if (r() < 0.5) o.similarity = [0, 0.3, 0.55, 0.8, 1, 2][Math.floor(r() * 6)]!;
  if (r() < 0.3) o.shingleSize = 2 + Math.floor(r() * 4);
  if (r() < 0.6) o.indicators = { ...(r() < 0.4 ? { minShared: 1 + Math.floor(r() * 2) } : {}), ...(r() < 0.3 ? { kinds: ['wallet', 'device'] } : {}), ...(r() < 0.3 ? { maxShare: [0.1, 0.5, 1][Math.floor(r() * 3)]! } : {}), ...(r() < 0.2 ? { fromText: true } : {}) };
  if (r() < 0.6) o.burst = { windowMs: [1000, 60_000, 600_000, 10_000_000][Math.floor(r() * 4)]!, ...(r() < 0.4 ? { requireSignal: r() < 0.5 } : {}), ...(r() < 0.4 ? { similarity: [0, 0.2, 0.5, 2][Math.floor(r() * 4)]! } : {}) };
  if (r() < 0.5) o.proximity = { radiusKm: [0.05, 1, 5, 50][Math.floor(r() * 4)]!, ...(r() < 0.5 ? { windowMs: [60_000, 1_800_000][Math.floor(r() * 2)]! } : {}) };
  return o;
}

/** A partition as a canonical string: clusters of sorted ids, sorted. */
const partition = (clusters: Map<string, string[]>): string => [...clusters.values()].map(m => [...m].sort().join(',')).sort().join(' | ');

/** The partition implied by a list of links alone. */
function fromLinks(ids: string[], links: { a: string; b: string }[]): string {
  const parent = new Map(ids.map(i => [i, i]));
  const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
  for (const l of links) parent.set(find(l.b), find(l.a));
  const groups = new Map<string, string[]>();
  for (const i of ids) groups.set(find(i), [...(groups.get(find(i)) ?? []), i]);
  return partition(groups);
}

describe('clusterItems: indexed implementation vs. the pairwise reference', () => {
  it('produces the same partition and geo flags on 400 random inputs across every option combination', () => {
    let merged = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const items = randomItems(r, 5 + Math.floor(r() * 70));
      const opts = randomOptions(r);
      const got = clusterItems(items, opts);
      const want = clusterItemsReference(items, opts);
      const ctx = `seed ${seed} opts ${JSON.stringify(opts)}`;
      expect(partition(got.clusters), ctx).toBe(partition(want.clusters));
      expect([...got.geoFlags.keys()].sort(), ctx).toEqual([...want.geoFlags.keys()].sort());
      // The reported links are a complete explanation: on their own they rebuild the clusters.
      expect(fromLinks(items.map(i => i.id), got.links), ctx).toBe(partition(got.clusters));
      // clusterOf and clusters agree.
      for (const [root, members] of got.clusters) for (const m of members) expect(got.clusterOf.get(m)).toBe(root);
      if (got.clusters.size < items.length) merged++;
    }
    // The generator really exercises merging, not just singletons.
    expect(merged).toBeGreaterThan(300);
  });

  it('matches the reference on groups larger than the pair-reporting cap', () => {
    const hub = { kind: 'telegram' as const, value: 'hub' };
    const items: Item[] = Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, text: `post number ${i} about something entirely different ${i * 7}`, origin: { id: `c${i}`, kind: 'telegram' }, at: 1000 * i, ...(i % 2 === 0 ? { indicators: [hub] } : {}) }));
    for (const opts of [{ indicators: { maxShare: 1 } }, { burst: { windowMs: 2500 } }, { burst: { windowMs: 1500, requireSignal: false } }] as ClusterOptions[]) {
      const got = clusterItems(items, { similarity: 2, ...opts });
      expect(partition(got.clusters)).toBe(partition(clusterItemsReference(items, { similarity: 2, ...opts }).clusters));
      expect(fromLinks(items.map(i => i.id), got.links)).toBe(partition(got.clusters));
      // A 100-member group is explained by a chain, not by 4,950 pairs.
      expect(got.links.length).toBeLessThan(250);
    }
  });

  it('semantic pairs from the caller merge only above the threshold and inside the time window', () => {
    const items: Item[] = [
      { id: 'he', text: 'פיצוץ גדול בנמל חיפה', origin: { id: 'a', kind: 'telegram' }, at: 0 },
      { id: 'ar', text: 'انفجار كبير في ميناء حيفا', origin: { id: 'b', kind: 'telegram' }, at: 60_000 },
      { id: 'en', text: 'Large explosion at Haifa port', origin: { id: 'c', kind: 'feed' }, at: 86_400_000 },
    ];
    const pairs = [{ a: 'he', b: 'ar', score: 0.95 }, { a: 'he', b: 'en', score: 0.96 }, { a: 'ar', b: 'en', score: 0.5 }, { a: 'he', b: 'ghost', score: 1 }];
    expect(clusterItems(items).clusters.size).toBe(3);
    expect(clusterItems(items, { semantic: { pairs } }).clusters.size).toBe(1);
    // With a window, the report a day later stays independent: similar meaning is not the same as a copy.
    const r = clusterItems(items, { semantic: { pairs, withinMs: 600_000 } });
    expect(r.clusters.size).toBe(2);
    expect(r.links).toEqual([{ a: 'he', b: 'ar', reason: 'semantic', detail: '0.95' }]);
    expect(clusterItems(items, { semantic: { pairs, threshold: 0.99 } }).clusters.size).toBe(3);
  });
});

describe('clusterItems: scale', () => {
  const time = (fn: () => unknown): number => {
    // Best of three, so one garbage-collection pause does not decide the result.
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      fn();
      best = Math.min(best, performance.now() - t);
    }
    return best;
  };

  it('clusters 10,000 ledger-style events by indicators, bursts and proximity in under 200 ms', () => {
    const r = rng(42);
    const n = 10_000;
    const items: Item[] = Array.from({ length: n }, (_, i) => {
      const c = CENTRES[Math.floor(r() * 4)]!;
      return {
        id: `e${i}`, text: `ledger event ${i}`, origin: { id: `acct-${Math.floor(r() * 6000)}`, kind: 'sensor' },
        at: 1_700_000_000_000 + Math.floor(r() * 86_400_000),
        indicators: [{ kind: 'wallet', value: `w${Math.floor(r() * 4000)}` }, { kind: 'device', value: `d${Math.floor(r() * 5000)}` }, { kind: 'ip', value: `10.${Math.floor(r() * 250)}.${Math.floor(r() * 250)}.1` }],
        geo: { lat: c[0] + (r() - 0.5) * 2, lon: c[1] + (r() - 0.5) * 2 },
      };
    });
    const opts: ClusterOptions = { similarity: 2, indicators: {}, burst: { windowMs: 60_000 }, proximity: { radiusKm: 0.05, windowMs: 600_000 } };
    const result = clusterItems(items, opts);
    expect(result.clusters.size).toBeGreaterThan(1);
    expect(result.clusters.size).toBeLessThan(n);
    const ms = time(() => clusterItems(items, opts));
    console.log(`10,000 events, indicators + burst + proximity: ${ms.toFixed(0)} ms, ${result.clusters.size} clusters`);
    expect(ms).toBeLessThan(200);
  });

  it('clusters 10,000 short texts by near-duplicate wording far faster than comparing every pair', () => {
    const r = rng(7);
    const pick = () => WORDS[Math.floor(r() * WORDS.length)]!;
    const base = Array.from({ length: 1500 }, (_, i) => `story ${i} ${Array.from({ length: 12 }, pick).join(' ')}`);
    const items: Item[] = Array.from({ length: 10_000 }, (_, i) => ({ id: `t${i}`, text: `${base[Math.floor(r() * base.length)]!} ${pick()} ${i % 3 === 0 ? i : ''}`, origin: { id: `ch${i}`, kind: 'telegram' } }));
    const result = clusterItems(items);
    // Copies of a story collapse onto it: about as many clusters as stories.
    expect(result.clusters.size).toBeGreaterThan(1000);
    expect(result.clusters.size).toBeLessThan(2500);
    const ms = time(() => clusterItems(items));
    console.log(`10,000 texts, near-duplicate wording: ${ms.toFixed(0)} ms, ${result.clusters.size} clusters`);
    // Tokenising 10,000 texts is most of this; 50 million pairwise comparisons would take tens of seconds.
    expect(ms).toBeLessThan(1500);
  });

  it('grows roughly linearly: four times the input takes far less than sixteen times as long', () => {
    const make = (n: number): Item[] => {
      const r = rng(n);
      return Array.from({ length: n }, (_, i) => ({ id: `e${i}`, text: '', origin: { id: `a${i}`, kind: 'sensor' as const }, at: Math.floor(r() * n * 1000), indicators: [{ kind: 'wallet' as const, value: `w${Math.floor(r() * n * 0.4)}` }], geo: { lat: 30 + r() * 10, lon: 30 + r() * 10 } }));
    };
    const opts: ClusterOptions = { similarity: 2, indicators: {}, burst: { windowMs: 5000 }, proximity: { radiusKm: 0.2 } };
    const small = make(5000);
    const large = make(20_000);
    clusterItems(small, opts);
    const a = time(() => clusterItems(small, opts));
    const b = time(() => clusterItems(large, opts));
    console.log(`5,000 items: ${a.toFixed(0)} ms; 20,000 items: ${b.toFixed(0)} ms (x${(b / a).toFixed(1)})`);
    expect(b / a).toBeLessThan(10);
  });
});

describe('groundReport with caller-supplied semantic matches', () => {
  it('grounds a translated sentence as a paraphrase, and leaves wording-based results alone', () => {
    const l = new ProvenanceLedger();
    const he = l.addUntrusted('עובדי הנמל בלימסול פתחו בשביתה ביום שני', { id: 'he-channel', kind: 'telegram', grade: { r: 'C', c: 3 } });
    const en = l.addUntrusted('Cargo handling at Limassol is suspended.', { id: 'authority', kind: 'web', grade: { r: 'A', c: 2 } });
    const report = 'Dock workers in Limassol began a strike on Monday. Cargo handling at Limassol is suspended. The army will deploy tomorrow.';
    const plain = groundReport(report, l);
    expect(plain.map(s => s.status)).toEqual(['ungrounded', 'grounded', 'ungrounded']);

    const g = groundReport(report, l, { semanticMatches: { matches: { 0: [{ spanId: he.id, score: 0.91 }, { spanId: 'nope', score: 0.99 }], 1: [{ spanId: he.id, score: 0.95 }], 2: [{ spanId: en.id, score: 0.4 }] } } });
    expect(g.map(s => s.status)).toEqual(['paraphrase', 'grounded', 'ungrounded']);
    expect(g[0]).toMatchObject({ semanticScore: 0.91, independentOrigins: 1, bestGrade: 'C3' });
    expect(g[0]!.support.map(s => s.origin.id)).toEqual(['he-channel']);
    // Already grounded by wording: the semantic match does not replace its support.
    expect(g[1]!.support.map(s => s.origin.id)).toEqual(['authority']);
    expect(g[2]!.semanticScore).toBe(0.4);
    expect(groundReport(report, l, { semanticMatches: { matches: { 0: [{ spanId: he.id, score: 0.91 }] }, threshold: 0.95 } })[0]!.status).toBe('ungrounded');
  });
});
