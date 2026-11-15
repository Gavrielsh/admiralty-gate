/**
 * Deterministic Analysis of Competing Hypotheses (Heuer).
 *
 * Division of labour, following the "LLM fills cells, code does the
 * arithmetic" pattern: a model (or an analyst) may propose how each piece of
 * evidence bears on each hypothesis, but the ranking, diagnosticity and
 * sensitivity analysis are plain code, reproducible and inspectable.
 *
 * Cell scale: -2 strongly inconsistent, -1 inconsistent, 0 neutral/NA,
 * +1 consistent, +2 strongly consistent. Per Heuer, hypotheses are ranked by
 * how much evidence is INCONSISTENT with them, because consistent evidence
 * often fits several hypotheses and so discriminates little.
 */
import { weightOf, type Grade } from './grades.js';

export type Cell = -2 | -1 | 0 | 1 | 2;

export interface AchEvidence {
  id: string;
  label: string;
  /** Admiralty grade of this evidence; weight comes from it. Ungraded evidence gets `defaultWeight`. */
  grade?: Grade;
}

export interface AchInput {
  hypotheses: { id: string; label: string }[];
  evidence: AchEvidence[];
  /** cells[evidenceId][hypothesisId] */
  cells: Record<string, Record<string, Cell>>;
  defaultWeight?: number;
}

export interface HypothesisScore {
  id: string;
  label: string;
  /** Weighted sum of inconsistency (>= 0). Lower is better. */
  inconsistency: number;
  /** Weighted sum of consistency (>= 0), reported but not used for ranking. */
  consistency: number;
}

export interface EvidenceDiagnosticity {
  id: string;
  label: string;
  weight: number;
  /** Spread of the row across hypotheses (max - min), weighted. 0 = does not discriminate. */
  diagnosticity: number;
}

export interface AchResult {
  ranking: HypothesisScore[];
  leader: string;
  /** Margin between best and second-best inconsistency (0 when tied or a single hypothesis). */
  margin: number;
  diagnosticity: EvidenceDiagnosticity[];
  /** Evidence whose removal changes the leading hypothesis: the load-bearing items to double check. */
  critical: { id: string; label: string; leaderWithoutIt: string }[];
  /** Evidence rows that do not discriminate at all. */
  nonDiagnostic: string[];
}

function weightFor(e: AchEvidence, def: number): number {
  return e.grade ? weightOf(e.grade) : def;
}

function rank(input: AchInput, skip?: string): HypothesisScore[] {
  const def = input.defaultWeight ?? 0.5;
  const scores = input.hypotheses.map<HypothesisScore>(h => ({ id: h.id, label: h.label, inconsistency: 0, consistency: 0 }));
  for (const e of input.evidence) {
    if (e.id === skip) continue;
    const w = weightFor(e, def);
    for (const s of scores) {
      const c = input.cells[e.id]?.[s.id] ?? 0;
      if (c < 0) s.inconsistency += w * -c;
      else if (c > 0) s.consistency += w * c;
    }
  }
  // Least inconsistency first; ties broken by higher consistency, then id for determinism.
  return scores.sort((a, b) => a.inconsistency - b.inconsistency || b.consistency - a.consistency || a.id.localeCompare(b.id));
}

export function ach(input: AchInput): AchResult {
  if (input.hypotheses.length === 0) throw new Error('ACH needs at least one hypothesis');
  const def = input.defaultWeight ?? 0.5;
  const ranking = rank(input);
  const leader = ranking[0]!.id;
  const margin = ranking.length > 1 ? ranking[1]!.inconsistency - ranking[0]!.inconsistency : 0;

  const diagnosticity = input.evidence.map<EvidenceDiagnosticity>(e => {
    const row = input.hypotheses.map(h => input.cells[e.id]?.[h.id] ?? 0);
    const w = weightFor(e, def);
    return { id: e.id, label: e.label, weight: w, diagnosticity: (Math.max(...row) - Math.min(...row)) * w };
  });

  const critical: AchResult['critical'] = [];
  for (const e of input.evidence) {
    const without = rank(input, e.id)[0]!;
    const tie = rank(input, e.id).filter(r => r.inconsistency === without.inconsistency && r.consistency === without.consistency).length > 1;
    if (without.id !== leader || tie) critical.push({ id: e.id, label: e.label, leaderWithoutIt: tie ? `${without.id} (tie)` : without.id });
  }

  return {
    ranking,
    leader,
    margin,
    diagnosticity: diagnosticity.sort((a, b) => b.diagnosticity - a.diagnosticity),
    critical,
    nonDiagnostic: diagnosticity.filter(d => d.diagnosticity === 0).map(d => d.id),
  };
}

/** Pluggable cell scorer (e.g. an LLM call). Its output is validated; anything off-scale is rejected, not coerced. */
export type CellScorer = (evidence: AchEvidence, hypothesis: { id: string; label: string }) => Promise<number>;

export async function fillCells(
  hypotheses: AchInput['hypotheses'],
  evidence: AchEvidence[],
  scorer: CellScorer,
): Promise<AchInput['cells']> {
  const cells: AchInput['cells'] = {};
  for (const e of evidence) {
    cells[e.id] = {};
    for (const h of hypotheses) {
      const v = await scorer(e, h);
      if (![-2, -1, 0, 1, 2].includes(v)) throw new Error(`Scorer returned off-scale value ${v} for ${e.id} x ${h.id}`);
      cells[e.id]![h.id] = v as Cell;
    }
  }
  return cells;
}

export interface AttributionRule {
  /** Minimum gap in weighted inconsistency between the leader and the runner-up. Default 0.5. */
  minMargin: number;
  /** Minimum number of evidence rows that discriminate between hypotheses at all. Default 2. */
  minDiagnostic: number;
  /** A load-bearing (critical) item must weigh at least this much. Default 0.5 (roughly C2 or better). */
  minCriticalWeight: number;
}

export const DEFAULT_ATTRIBUTION_RULE: AttributionRule = { minMargin: 0.5, minDiagnostic: 2, minCriticalWeight: 0.5 };

/**
 * May the leading hypothesis be stated as the attribution? Deterministic, like canRelease: the model has no vote.
 * It is held back when the lead is thin, when too little evidence discriminates, or when the conclusion flips on
 * the removal of a single weak or ungraded item.
 */
export function attributionGate(result: AchResult, rule: AttributionRule = DEFAULT_ATTRIBUTION_RULE): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (result.ranking.length < 2) reasons.push('only one hypothesis was considered; an attribution needs competing explanations');
  else if (result.margin < rule.minMargin)
    reasons.push(`the lead over the next hypothesis is ${result.margin.toFixed(2)}, below ${rule.minMargin}`);
  const diagnostic = result.diagnosticity.filter(d => d.diagnosticity > 0).length;
  if (diagnostic < rule.minDiagnostic) reasons.push(`only ${diagnostic} evidence item(s) discriminate between the hypotheses; needs ${rule.minDiagnostic}`);
  const weight = new Map(result.diagnosticity.map(d => [d.id, d.weight]));
  for (const c of result.critical)
    if ((weight.get(c.id) ?? 0) < rule.minCriticalWeight)
      reasons.push(`the conclusion flips without "${c.label}", and that item is weak (weight ${(weight.get(c.id) ?? 0).toFixed(2)})`);
  return { allowed: reasons.length === 0, reasons };
}
