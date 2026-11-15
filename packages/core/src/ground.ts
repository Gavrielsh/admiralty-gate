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
}

export interface GroundOptions extends ClusterOptions {
  /** Overlap at or above which a sentence is "grounded". Default 0.6. */
  grounded?: number;
  /** Overlap at or above which a sentence is "weak" rather than "ungrounded". Default 0.3. */
  weak?: number;
  /** A span counts as support if its overlap is at least this share of the best overlap. Default 0.8. */
  supportBand?: number;
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

  return sentences(report).map<GroundedSentence>(text => {
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
    const supporting = best >= lo ? scored.filter(x => x.overlap >= best * band) : [];
    const untrusted = supporting.filter(x => !x.span.trusted);

    let status: GroundStatus = best >= hi ? 'grounded' : best >= lo ? 'weak' : 'ungrounded';
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
    const out: GroundedSentence = {
      text,
      status,
      overlap: best,
      support: supporting.map(x => ({ spanId: x.span.id, origin: x.span.origin, overlap: x.overlap })),
      independentOrigins: clusters.size,
      unsupportedSpecifics: toks.filter(t => isSpecific(t) && !all.has(t)),
      fromFlaggedSource: untrusted.some(x => x.span.flags.length > 0),
    };
    if (bestGrade) out.bestGrade = gradeString(bestGrade);
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
        g.fromFlaggedSource ? 'source has injection-style flags' : '',
      ].filter(Boolean);
      return `[${bits.join(' | ')}] ${g.text}`;
    })
    .join('\n');
}
