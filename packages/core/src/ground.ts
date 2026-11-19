/**
 * Report grounding: which recorded sources does each sentence of a draft
 * (a summary, an alert, a briefing written by a model) actually rest on?
 *
 * A hijacked or simply careless model can write anything in prose; the gate
 * does not see prose. This module gives the reader a deterministic check:
 * every sentence is matched against the spans in the provenance ledger and
 * labelled with the origins it overlaps, how many of them are independent,
 * the best Admiralty grade among them, and any figure or identifier in the
 * sentence that appears in NO source.
 *
 * Limits, stated plainly: matching is lexical. A faithful paraphrase scores
 * lower than a copy, a translation scores near zero, and a sentence that
 * reuses a source's words to say the opposite still scores high. It shows
 * lineage, not truth. Use it to direct human attention, not to replace it.
 */
import { extractEntities, indicatorKey, type Indicator } from './entities.js';
import { extractCoordinates, haversineKm, type GeoPoint } from './geo.js';
import { gradeString, weightOf, type Grade } from './grades.js';
import { clusterItems, type ClusterOptions } from './independence.js';
import type { Origin, ProvenanceLedger, Span } from './provenance.js';
import { tokens } from './text.js';

export type GroundStatus =
  /** Overlaps a trusted operator span: the operator said it. */
  | 'operator'
  /** Most of its content words are found in one untrusted source. */
  | 'grounded'
  /** Only partially found in any source. */
  | 'weak'
  /**
   * Little or no shared wording, but an embedding supplied by the caller says a source means the same thing
   * (a translation or a paraphrase). Weaker than 'grounded': it rests on a model's judgement of similarity.
   */
  | 'paraphrase'
  /** Not found in any recorded source: model-originated. */
  | 'ungrounded';

export interface SentenceSupport {
  spanId: string;
  origin: Origin;
  /** Share of the sentence's (rarity-weighted) content tokens present in this span, 0..1. */
  overlap: number;
}

export interface GroundedSentence {
  text: string;
  status: GroundStatus;
  /** Best overlap across spans. */
  overlap: number;
  support: SentenceSupport[];
  /** Independence clusters among the supporting untrusted spans (echoes count once). */
  independentOrigins: number;
  /** Best grade among supporting spans, e.g. "B2"; undefined if none is graded. */
  bestGrade?: string;
  /** Numbers, hosts, handles and other identifier-like tokens that occur in no recorded span at all. */
  unsupportedSpecifics: string[];
  /** Supporting span carried injection-style telemetry flags. */
  fromFlaggedSource: boolean;
  /** Best caller-supplied semantic score for this sentence, when semantic matches were given. */
  semanticScore?: number;
  /**
   * Typed view of the hard identifiers in `unsupportedSpecifics`: IPs, wallets, transaction hashes, ASNs, phones,
   * handles, domains and coordinate pairs that no recorded source contains. A coordinate pair is "found" when a
   * source has a pair within `coordToleranceKm`, so honest rounding is not flagged.
   */
  unsupportedEntities: { kind: Indicator['kind'] | 'coordinates'; value: string }[];
  /**
   * Fabricated links: two identifiers that each appear in the sources, but never in the SAME source. "Wallet W was
   * used from IP X" needs one source that has both; two sources that each have one do not establish it.
   */
  unsupportedLinks: { a: string; b: string }[];
}

export interface GroundOptions extends ClusterOptions {
  /** Overlap at or above which a sentence is "grounded". Default 0.6. */
  grounded?: number;
  /** Overlap at or above which a sentence is "weak" rather than "ungrounded". Default 0.3. */
  weak?: number;
  /** A span counts as support if its overlap is at least this share of the best overlap. Default 0.8. */
  supportBand?: number;
  /** How far a coordinate pair in the report may be from one in a source and still count as that location. Default 1 km. */
  coordToleranceKm?: number;
  /**
   * Semantic matches computed OUTSIDE the core: for a sentence index (its position in `sentences(report)`), the
   * spans an embedding model finds closest in meaning. Used only when wording does not already ground the sentence.
   */
  semanticMatches?: { matches: Readonly<Record<number, readonly { spanId: string; score: number }[]>>; threshold?: number };
}

/** Sentence split over Latin, Hebrew, Arabic, Persian, Urdu, Devanagari and CJK terminators, and line breaks. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  // A full stop only ends a sentence when followed by whitespace, so "example.org" and "10.0.0.1" stay whole.
  const re = /[^.!?؟۔।。！？\n]+(?:[.](?!\s|$)[^.!?؟۔।。！？\n]*)*[.!?؟۔।。！？]*/gu;
  for (const m of text.match(re) ?? []) {
    const s = m.trim().replace(/^[-*#>\s]+/, '');
    if (tokens(s).length >= 2) out.push(s);
  }
  return out;
}

const isSpecific = (t: string): boolean => /\p{N}/u.test(t) || /[@_/]/.test(t) || /\.[\p{L}]{2,}$/u.test(t);

export function groundReport(report: string, ledger: ProvenanceLedger, opts: GroundOptions = {}): GroundedSentence[] {
  const hi = opts.grounded ?? 0.6;
  const lo = opts.weak ?? 0.3;
  const band = opts.supportBand ?? 0.8;
  const spans = ledger.spans();
  const sets = new Map<string, Set<string>>();
  const df = new Map<string, number>();
  const all = new Set<string>();
  const coordTol = opts.coordToleranceKm ?? 1;
  const spanEntities = spans.map(s => new Set(extractEntities(s.text).map(indicatorKey)));
  const spanCoords = spans.map(s => extractCoordinates(s.text));
  const coordKey = (p: GeoPoint): string => `${p.lat},${p.lon}`;
  const hasCoord = (i: number, p: GeoPoint): boolean => spanCoords[i]!.some(q => haversineKm(p, q) <= coordTol);
  for (const s of spans) {
    const set = new Set<string>([...s.tokens, ...s.hosts]);
    sets.set(s.id, set);
    for (const t of set) {
      df.set(t, (df.get(t) ?? 0) + 1);
      all.add(t);
    }
  }
  // Rarity weight: a word present in every source ("the", "של") says little about which source a sentence came from.
  const n = spans.length;
  const idf = (t: string): number => Math.log((n + 1) / ((df.get(t) ?? 0) + 0.5)) + 0.1;

  const spanById = new Map(spans.map(s => [s.id, s]));
  return sentences(report).map<GroundedSentence>((text, sentenceIndex) => {
    const toks = [...new Set(tokens(text))];
    const total = toks.reduce((a, t) => a + idf(t), 0);
    const scored: { span: Span; overlap: number }[] = [];
    for (const s of spans) {
      const set = sets.get(s.id)!;
      let hit = 0;
      for (const t of toks) if (set.has(t)) hit += idf(t);
      if (hit > 0) scored.push({ span: s, overlap: total ? hit / total : 0 });
    }
    scored.sort((a, b) => b.overlap - a.overlap);
    const best = scored[0]?.overlap ?? 0;
    let supporting = best >= lo ? scored.filter(x => x.overlap >= best * band) : [];
    let status: GroundStatus = best >= hi ? 'grounded' : best >= lo ? 'weak' : 'ungrounded';
    let semanticScore: number | undefined;
    if (opts.semanticMatches) {
      const thr = opts.semanticMatches.threshold ?? 0.85;
      const matches = (opts.semanticMatches.matches[sentenceIndex] ?? []).filter(m => spanById.has(m.spanId)).sort((a, b) => b.score - a.score);
      semanticScore = matches[0]?.score;
      const good = matches.filter(m => m.score >= thr);
      if (status !== 'grounded' && good.length) {
        status = 'paraphrase';
        supporting = good.map(m => ({ span: spanById.get(m.spanId)!, overlap: scored.find(x => x.span.id === m.spanId)?.overlap ?? 0 }));
      }
    }
    const untrusted = supporting.filter(x => !x.span.trusted);

    if (status !== 'ungrounded' && supporting.some(x => x.span.trusted && x.overlap >= hi)) status = 'operator';

    const { clusters } = clusterItems(
      untrusted.map(x => ({ id: x.span.id, text: x.span.text, origin: x.span.origin })),
      opts,
    );
    let bestGrade: Grade | undefined;
    for (const x of untrusted) {
      const g = x.span.origin.grade;
      if (g && (!bestGrade || weightOf(g) > weightOf(bestGrade))) bestGrade = g;
    }
    // Hard identifiers and coordinates, checked as wholes rather than token by token.
    const ents = extractEntities(text);
    const coords = extractCoordinates(text);
    const coordTokens = new Set(coords.flatMap(p => [String(Math.abs(p.lat)), String(Math.abs(p.lon)), String(p.lat), String(p.lon)]));
    const unsupportedEntities: GroundedSentence['unsupportedEntities'] = [];
    const present: { label: string; inSpan: (i: number) => boolean }[] = [];
    for (const e of ents) {
      const k = indicatorKey(e);
      if (spanEntities.some(set => set.has(k))) present.push({ label: e.value, inSpan: i => spanEntities[i]!.has(k) });
      else if (e.kind !== 'domain' || !all.has(e.value)) unsupportedEntities.push({ kind: e.kind, value: e.value });
    }
    for (const p of coords) {
      if (spans.some((_, i) => hasCoord(i, p))) present.push({ label: coordKey(p), inSpan: i => hasCoord(i, p) });
      else unsupportedEntities.push({ kind: 'coordinates', value: coordKey(p) });
    }
    const unsupportedLinks: GroundedSentence['unsupportedLinks'] = [];
    for (let i = 0; i < present.length && unsupportedLinks.length < 20; i++)
      for (let j = i + 1; j < present.length; j++)
        if (!spans.some((_, k) => present[i]!.inSpan(k) && present[j]!.inSpan(k))) unsupportedLinks.push({ a: present[i]!.label, b: present[j]!.label });

    const tokenSpecifics = toks.filter(t => isSpecific(t) && !all.has(t) && !coordTokens.has(t));
    const seen = new Set(tokenSpecifics.map(t => t.toLowerCase()));
    const out: GroundedSentence = {
      text,
      status,
      overlap: best,
      support: supporting.map(x => ({ spanId: x.span.id, origin: x.span.origin, overlap: x.overlap })),
      independentOrigins: clusters.size,
      unsupportedSpecifics: [...tokenSpecifics, ...unsupportedEntities.map(e => e.value).filter(v => !seen.has(v.toLowerCase()))],
      fromFlaggedSource: untrusted.some(x => x.span.flags.length > 0),
      unsupportedEntities,
      unsupportedLinks,
    };
    if (bestGrade) out.bestGrade = gradeString(bestGrade);
    if (semanticScore !== undefined) out.semanticScore = semanticScore;
    return out;
  });
}

export interface GroundingSummary {
  sentences: number;
  operator: number;
  grounded: number;
  weak: number;
  ungrounded: number;
  singleOrigin: number;
  withUnsupportedSpecifics: number;
}

export function summariseGrounding(gs: readonly GroundedSentence[]): GroundingSummary {
  const count = (s: GroundStatus) => gs.filter(g => g.status === s).length;
  return {
    sentences: gs.length,
    operator: count('operator'),
    grounded: count('grounded'),
    weak: count('weak'),
    ungrounded: count('ungrounded'),
    singleOrigin: gs.filter(g => (g.status === 'grounded' || g.status === 'weak') && g.independentOrigins === 1).length,
    withUnsupportedSpecifics: gs.filter(g => g.unsupportedSpecifics.length > 0).length,
  };
}

/** Plain-text annotation of a report: one line per sentence with its lineage, for an analyst to read. */
export function annotateReport(gs: readonly GroundedSentence[]): string {
  return gs
    .map(g => {
      const src = g.support.map(s => `${s.origin.kind}:${s.origin.id}`);
      const bits = [
        g.status.toUpperCase(),
        g.status === 'ungrounded' ? 'no recorded source' : `${[...new Set(src)].join(', ')}`,
        g.status === 'grounded' || g.status === 'weak' ? `${g.independentOrigins} independent` : '',
        g.bestGrade ? `best ${g.bestGrade}` : '',
        g.unsupportedSpecifics.length ? `NOT IN ANY SOURCE: ${g.unsupportedSpecifics.join(', ')}` : '',
        g.unsupportedLinks.length ? `LINK IN NO SINGLE SOURCE: ${g.unsupportedLinks.map(l => `${l.a} <-> ${l.b}`).join('; ')}` : '',
        g.fromFlaggedSource ? 'source has injection-style flags' : '',
      ].filter(Boolean);
      return `[${bits.join(' | ')}] ${g.text}`;
    })
    .join('\n');
}
