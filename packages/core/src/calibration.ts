/**
 * Calibration and scoring for probabilistic forecasts.
 *
 * Forecasting engines (including OSIRIS's OI Forecast) emit probabilities.
 * Whether those probabilities mean anything is an empirical question, answered
 * only by scoring them against resolved outcomes. This module provides the
 * scoring rules, a reliability table, and a Platt-scaling recalibrator, with
 * no dependencies.
 */

export interface Resolved {
  /** Forecast probability that the event happens, in [0, 1]. */
  p: number;
  /** What happened: 1 if the event occurred, else 0. */
  outcome: 0 | 1;
}

const clamp = (p: number, eps = 1e-6) => Math.min(1 - eps, Math.max(eps, p));

export function brier(rs: readonly Resolved[]): number {
  if (!rs.length) return NaN;
  return rs.reduce((t, r) => t + (r.p - r.outcome) ** 2, 0) / rs.length;
}

export function logLoss(rs: readonly Resolved[]): number {
  if (!rs.length) return NaN;
  return rs.reduce((t, r) => t - (r.outcome ? Math.log(clamp(r.p)) : Math.log(1 - clamp(r.p))), 0) / rs.length;
}

/** Brier score of always forecasting the observed base rate: the bar a forecaster must clear to add information. */
export function baseRateBrier(rs: readonly Resolved[]): number {
  if (!rs.length) return NaN;
  const m = rs.reduce((t, r) => t + r.outcome, 0) / rs.length;
  return m * (1 - m);
}

/** 1 - brier / baseline: positive means better than knowing only the base rate. */
export function skillScore(rs: readonly Resolved[]): number {
  const base = baseRateBrier(rs);
  return base === 0 ? NaN : 1 - brier(rs) / base;
}

export interface Bin {
  lo: number;
  hi: number;
  n: number;
  meanForecast: number;
  observedRate: number;
}

export function reliabilityTable(rs: readonly Resolved[], bins = 10): Bin[] {
  const out: Bin[] = [];
  for (let i = 0; i < bins; i++) {
    const lo = i / bins;
    const hi = (i + 1) / bins;
    const inBin = rs.filter(r => r.p >= lo && (i === bins - 1 ? r.p <= hi : r.p < hi));
    if (!inBin.length) continue;
    out.push({
      lo,
      hi,
      n: inBin.length,
      meanForecast: inBin.reduce((t, r) => t + r.p, 0) / inBin.length,
      observedRate: inBin.reduce((t, r) => t + r.outcome, 0) / inBin.length,
    });
  }
  return out;
}

/** Expected calibration error: sample-weighted gap between forecast and observed frequency. */
export function ece(rs: readonly Resolved[], bins = 10): number {
  const n = rs.length;
  if (!n) return NaN;
  return reliabilityTable(rs, bins).reduce((t, b) => t + (b.n / n) * Math.abs(b.meanForecast - b.observedRate), 0);
}

const logit = (p: number) => Math.log(clamp(p) / (1 - clamp(p)));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export interface Platt {
  a: number;
  b: number;
}

/**
 * Fit p' = sigmoid(a * logit(p) + b) by Newton's method with a small ridge
 * toward the identity (a=1, b=0), so tiny samples do not produce wild maps.
 */
export function fitPlatt(rs: readonly Resolved[], ridge = 1e-3, iters = 50): Platt {
  let a = 1;
  let b = 0;
  for (let it = 0; it < iters; it++) {
    let ga = ridge * (a - 1);
    let gb = ridge * b;
    let haa = ridge;
    let hab = 0;
    let hbb = ridge;
    for (const r of rs) {
      const x = logit(r.p);
      const q = sigmoid(a * x + b);
      const e = q - r.outcome;
      const w = q * (1 - q);
      ga += e * x;
      gb += e;
      haa += w * x * x;
      hab += w * x;
      hbb += w;
    }
    const det = haa * hbb - hab * hab;
    if (Math.abs(det) < 1e-12) break;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    a -= da;
    b -= db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return { a, b };
}

export const applyPlatt = (p: number, m: Platt): number => sigmoid(m.a * logit(p) + m.b);

/** Parse OSIRIS-style ledger JSONL: forecast records, and (if present) resolution records. */
export interface LedgerForecast {
  id: string;
  statement: string;
  probability: number;
  ts: number;
  resolve_after?: number;
}

export function readForecastLedger(jsonl: string): { forecasts: LedgerForecast[]; resolutions: Map<string, 0 | 1> } {
  const forecasts: LedgerForecast[] = [];
  const resolutions = new Map<string, 0 | 1>();
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (d.kind === 'forecast' && typeof d.id === 'string' && typeof d.probability === 'number') {
      forecasts.push({
        id: d.id,
        statement: String(d.statement ?? ''),
        probability: d.probability,
        ts: Number(d.ts ?? 0),
        resolve_after: typeof d.resolve_after === 'number' ? d.resolve_after : undefined,
      });
    } else if ((d.kind === 'resolution' || d.kind === 'resolved') && typeof d.id === 'string') {
      const o = d.outcome ?? d.resolved ?? d.result;
      if (o === 1 || o === true || o === 'yes') resolutions.set(d.id, 1);
      else if (o === 0 || o === false || o === 'no') resolutions.set(d.id, 0);
    }
  }
  return { forecasts, resolutions };
}
