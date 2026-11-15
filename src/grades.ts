/**
 * NATO/Admiralty-style source grading, turned into numbers the rest of the
 * library can compute with.
 *
 * Reliability (A-F) describes the SOURCE; credibility (1-6) describes the
 * INFORMATION as received, judged before corroboration. Corroboration is
 * computed by this library (see corroborate.ts), so callers must not fold it
 * into the credibility digit as well, or it is counted twice.
 *
 * The numeric weights are an explicit, auditable heuristic, not calibrated
 * probabilities. calibration.ts exists so they can be fitted against resolved
 * outcomes; until then, treat scores as ordinal evidence strength.
 */

export type Reliability = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export type Credibility = 1 | 2 | 3 | 4 | 5 | 6;

export interface Grade {
  r: Reliability;
  c: Credibility;
}

/** How far a report from a source of this reliability should move belief. F (cannot be judged) moves nothing. */
export const RELIABILITY_WEIGHT: Readonly<Record<Reliability, number>> = {
  A: 0.9,
  B: 0.75,
  C: 0.55,
  D: 0.3,
  E: 0.1,
  F: 0,
};

/** Multiplier for the credibility of this particular piece of information. 6 (cannot be judged) moves nothing. */
export const CREDIBILITY_FACTOR: Readonly<Record<Credibility, number>> = {
  1: 1,
  2: 0.9,
  3: 0.75,
  4: 0.55,
  5: 0.3,
  6: 0,
};

export const gradeString = (g: Grade): string => `${g.r}${g.c}`;

export function parseGrade(s: string): Grade {
  const m = /^([A-Fa-f])([1-6])$/.exec(s.trim());
  if (!m) throw new Error(`Invalid Admiralty grade "${s}" (expected e.g. "B2")`);
  return { r: m[1]!.toUpperCase() as Reliability, c: Number(m[2]) as Credibility };
}

/** Evidential weight of one grade, in [0, 0.9]. */
export function weightOf(g: Grade): number {
  return RELIABILITY_WEIGHT[g.r] * CREDIBILITY_FACTOR[g.c];
}

/** Does this grade meet a minimum bar on both axes? (Lower letter / lower digit = better.) */
export function meets(g: Grade, min: Grade): boolean {
  return g.r <= min.r && g.c <= min.c;
}

/** The weaker of two grades on each axis: what a value derived from both can claim at most. */
export function weakest(a: Grade, b: Grade): Grade {
  return { r: a.r > b.r ? a.r : b.r, c: Math.max(a.c, b.c) as Credibility };
}

/** Estimative language bands in the style of public IC standards (ICD 203): probability range -> phrase. */
export const ESTIMATIVE_BANDS: readonly { max: number; phrase: string }[] = [
  { max: 0.05, phrase: 'almost no chance' },
  { max: 0.2, phrase: 'very unlikely' },
  { max: 0.45, phrase: 'unlikely' },
  { max: 0.55, phrase: 'roughly even chance' },
  { max: 0.8, phrase: 'likely' },
  { max: 0.95, phrase: 'very likely' },
  { max: 1.0001, phrase: 'almost certain' },
];

export function estimativePhrase(p: number): string {
  const x = Math.min(1, Math.max(0, p));
  return ESTIMATIVE_BANDS.find(b => x < b.max)!.phrase;
}
