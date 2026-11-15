/**
 * Independence-aware corroboration.
 *
 * For each claim key, evidence is grouped into independence clusters. A
 * cluster contributes ONE weight: the strongest item inside it (an echo
 * cannot outvote its origin). Independent clusters combine by noisy-OR:
 *
 *     support = 1 - prod_over_clusters(1 - weight_cluster)
 *
 * and likewise for contradicting evidence. Confidence is support * (1 - contra).
 * This is monotone, deterministic and auditable; it is NOT a calibrated
 * probability until calibration.ts has been used to fit it to outcomes.
 */
import { estimativePhrase, gradeString, weightOf, type Grade } from './grades.js';
import type { Indicator } from './entities.js';
import type { GeoFlag, GeoPoint } from './geo.js';
import { clusterItems, type ClusterLink, type ClusterOptions, type Item } from './independence.js';
import type { Origin } from './provenance.js';

export type Stance = 'supports' | 'contradicts';

export interface Evidence {
  id: string;
  claim: string;
  stance: Stance;
  text: string;
  origin: Origin;
  /** Grade of the source and information BEFORE corroboration. Falls back to origin.grade. */
  grade?: Grade;
  cites?: string[];
  at?: number;
  /** See Item: who produced it, where it says it happened, where its IP says it came from. */
  indicators?: readonly Indicator[];
  geo?: GeoPoint;
  claimedPlace?: string;
  ipGeo?: GeoPoint;
}

export type AssessmentFlag =
  | 'single-source'
  | 'echo-chamber'
  | 'contested'
  | 'ungraded-evidence'
  | 'no-independent-support'
  /** Supporting items were merged because they share indicators, a time burst or a location. */
  | 'coordinated'
  /** A supporting item's coordinates contradict the place it names or its IP geolocation. */
  | 'geo-mismatch';

export interface ClusterSummary {
  id: string;
  stance: Stance;
  members: string[];
  weight: number;
  bestGrade: string;
}

export interface Assessment {
  claim: string;
  support: number;
  contradiction: number;
  confidence: number;
  phrase: string;
  independentSupport: number;
  independentContradiction: number;
  rawSupportItems: number;
  clusters: ClusterSummary[];
  flags: AssessmentFlag[];
  /** Share of supporting items that turned out to be echoes: 1 - independentSupport / rawSupportItems. */
  echoReduction: number;
  /** Why items were merged into one origin. */
  links: ClusterLink[];
  /** Item id -> geospatial inconsistencies found on it. */
  geoFlags: Record<string, GeoFlag[]>;
}

function gradeOf(e: Evidence): Grade | undefined {
  return e.grade ?? e.origin.grade;
}

export function corroborate(evidence: readonly Evidence[], opts: ClusterOptions = {}): Assessment[] {
  const byClaim = new Map<string, Evidence[]>();
  for (const e of evidence) {
    const arr = byClaim.get(e.claim) ?? [];
    arr.push(e);
    byClaim.set(e.claim, arr);
  }

  const out: Assessment[] = [];
  for (const [claim, list] of byClaim) {
    // Independence is judged across ALL evidence on the claim, regardless of stance: a source
    // that republishes both sides is still one source.
    const items: Item[] = list.map(e => ({
      id: e.id, text: e.text, origin: e.origin, cites: e.cites ?? [],
      ...(e.indicators ? { indicators: e.indicators } : {}),
      ...(e.at !== undefined ? { at: e.at } : {}),
      ...(e.geo ? { geo: e.geo } : {}),
      ...(e.claimedPlace ? { claimedPlace: e.claimedPlace } : {}),
      ...(e.ipGeo ? { ipGeo: e.ipGeo } : {}),
    }));
    const { clusters, links, geoFlags } = clusterItems(items, opts);
    const byId = new Map(list.map(e => [e.id, e]));

    const summaries: ClusterSummary[] = [];
    const flags = new Set<AssessmentFlag>();
    let ungraded = false;

    for (const [cid, members] of clusters) {
      for (const stance of ['supports', 'contradicts'] as const) {
        const ms = members.map(m => byId.get(m)!).filter(e => e.stance === stance);
        if (!ms.length) continue;
        let best = 0;
        let bestGrade: Grade | undefined;
        for (const e of ms) {
          const g = gradeOf(e);
          if (!g) {
            ungraded = true;
            continue;
          }
          const w = weightOf(g);
          if (w > best) {
            best = w;
            bestGrade = g;
          }
        }
        summaries.push({
          id: cid,
          stance,
          members: ms.map(e => e.id),
          weight: best,
          bestGrade: bestGrade ? gradeString(bestGrade) : '--',
        });
      }
    }

    const combine = (st: Stance) =>
      1 - summaries.filter(s => s.stance === st).reduce((p, s) => p * (1 - s.weight), 1);
    const support = combine('supports');
    const contradiction = combine('contradicts');
    const confidence = support * (1 - contradiction);

    const supportClusters = summaries.filter(s => s.stance === 'supports' && s.weight > 0);
    const contraClusters = summaries.filter(s => s.stance === 'contradicts' && s.weight > 0);
    const rawSupportItems = list.filter(e => e.stance === 'supports').length;

    if (ungraded) flags.add('ungraded-evidence');
    if (supportClusters.length === 0) flags.add('no-independent-support');
    if (supportClusters.length === 1) flags.add('single-source');
    if (rawSupportItems >= 3 && supportClusters.length <= 1) flags.add('echo-chamber');
    if (support >= 0.4 && contradiction >= 0.4) flags.add('contested');
    const supporting = new Set(list.filter(e => e.stance === 'supports').map(e => e.id));
    if (links.some(l => (l.reason === 'shared-indicator' || l.reason === 'burst' || l.reason === 'proximity') && supporting.has(l.a) && supporting.has(l.b)))
      flags.add('coordinated');
    if ([...geoFlags.keys()].some(id => supporting.has(id))) flags.add('geo-mismatch');

    out.push({
      claim,
      support,
      contradiction,
      confidence,
      phrase: estimativePhrase(confidence),
      independentSupport: supportClusters.length,
      independentContradiction: contraClusters.length,
      rawSupportItems,
      clusters: summaries,
      flags: [...flags],
      echoReduction: rawSupportItems ? 1 - supportClusters.length / rawSupportItems : 0,
      links,
      geoFlags: Object.fromEntries(geoFlags),
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

export interface PublishRule {
  minIndependentSupport: number;
  minConfidence: number;
  /** Claims whose contradiction score exceeds this are held back as contested. */
  maxContradiction: number;
  /** Disallow release when the only support is an echo of a single origin. */
  blockEchoChamber: boolean;
  /** Hold back a claim whose supporting evidence has coordinates that contradict its place or IP geolocation. */
  blockGeoMismatch?: boolean;
}

export const DEFAULT_PUBLISH_RULE: PublishRule = {
  minIndependentSupport: 2,
  minConfidence: 0.8,
  maxContradiction: 0.3,
  blockEchoChamber: true,
  blockGeoMismatch: true,
};

export interface ReleaseDecision {
  allowed: boolean;
  reasons: string[];
}

/** May this assessment be escalated into a report or alert? Deterministic; the model has no vote. */
export function canRelease(a: Assessment, rule: PublishRule = DEFAULT_PUBLISH_RULE): ReleaseDecision {
  const reasons: string[] = [];
  if (a.independentSupport < rule.minIndependentSupport)
    reasons.push(`needs ${rule.minIndependentSupport} independent supporting origins, has ${a.independentSupport}`);
  if (a.confidence < rule.minConfidence)
    reasons.push(`confidence ${a.confidence.toFixed(2)} is below ${rule.minConfidence}`);
  if (a.contradiction > rule.maxContradiction)
    reasons.push(`contradiction ${a.contradiction.toFixed(2)} exceeds ${rule.maxContradiction}`);
  if (rule.blockEchoChamber && a.flags.includes('echo-chamber'))
    reasons.push('support is an echo of a single origin');
  if (rule.blockGeoMismatch && a.flags.includes('geo-mismatch'))
    reasons.push('supporting evidence has coordinates that contradict the place it names or its IP geolocation');
  return { allowed: reasons.length === 0, reasons };
}
