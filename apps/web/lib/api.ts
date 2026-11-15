export const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4319';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const KEY_SLOT = 'admiralty-api-key';

/**
 * The API key, when the server requires one. It is typed in by the operator and kept for this browser tab only
 * (sessionStorage): it is never baked into the page bundle, where anyone who can load the page could read it.
 */
export function getApiKey(): string {
  try {
    return window.sessionStorage.getItem(KEY_SLOT) ?? '';
  } catch {
    return '';
  }
}
export function setApiKey(key: string): void {
  try {
    if (key) window.sessionStorage.setItem(KEY_SLOT, key);
    else window.sessionStorage.removeItem(KEY_SLOT);
  } catch {
    /* storage unavailable: the key lives for this page load only */
  }
  window.dispatchEvent(new Event('admiralty-key-changed'));
}
export const authHeaders = (): Record<string, string> => {
  const k = typeof window === 'undefined' ? '' : getApiKey();
  return k ? { authorization: `Bearer ${k}` } : {};
};

export async function api<T>(path: string, init?: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: init?.method ?? 'GET',
      headers: { ...authHeaders(), ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new ApiError(0, `Cannot reach the gate server at ${API}. Is "npm run dev" running?`);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export type GateOutcome = 'ALLOW' | 'BLOCK' | 'ELICIT';
export type ProvenanceLabel = 'OPERATOR' | 'UNTRUSTED_TOOL_OUTPUT' | 'UNTRUSTED_SOURCE' | 'UNKNOWN';
export interface ArgProvenance { arg: string; value: string; label: ProvenanceLabel; origins: string[] }
export interface HostCheck { arg: string; value: string; result: 'authorised' | 'not-authorised' | 'not-a-single-host' }
export interface CallRecord {
  id: string; sessionId: string; source: 'sandbox' | 'mcp-proxy' | 'mcp-bridge'; at: number; tool: string;
  args: Record<string, unknown>; tier?: string; gate?: GateOutcome; reasons: string[]; provenance: ArgProvenance[];
  hostChecks: HostCheck[]; status: 'intercepted' | 'awaiting_approval' | 'executed' | 'blocked';
  approval?: { id: string; state: 'pending' | 'approved' | 'denied' | 'timeout' }; result?: string;
}
export interface PendingApproval {
  id: string; callId: string; sessionId: string; tool: string; args: Record<string, unknown>; tier?: string;
  reasons: string[]; provenance: ArgProvenance[]; requestedAt: number; expiresAt: number;
}
export interface GateEvent { seq: number; at: number; type: string; data: Record<string, unknown> }
export interface Scenario {
  id: string; title: string; group: string; description: string; operator: string; feed: string;
  call: { tool: string; args: Record<string, unknown> }; expect: GateOutcome;
}
export interface Providers { anthropic: boolean; openai: boolean; anthropicModel: string; openaiModel: string }
export interface AuditEntry { seq: number; at?: number; kind?: string; data?: Record<string, unknown>; prev?: string; hash?: string; unparseable?: string }
export interface AuditView { entries: AuditEntry[]; chainValid: boolean; brokenAt?: number; reason?: string; head: string | null; file?: string; quarantined?: { file: string; brokenAt: number; reason: string } }
export interface GroundedSentence {
  text: string; status: string; level: 'operator' | 'verified' | 'single' | 'paraphrase' | 'weak' | 'ungrounded'; semanticScore?: number; overlap: number;
  support: { spanId: string; origin: { id: string; kind: string }; overlap: number }[]; independentOrigins: number;
  bestGrade?: string; unsupportedSpecifics: string[]; fromFlaggedSource: boolean;
}
export interface GroundingResult {
  sentences: GroundedSentence[];
  summary: { sentences: number; operator: number; grounded: number; weak: number; ungrounded: number; singleOrigin: number; withUnsupportedSpecifics: number };
  sources: { spanId: string; id: string; kind: string; grade?: string; trusted: boolean; text: string }[];
}

export type IncidentStatus = 'released' | 'quarantined' | 'ring';
export interface IncidentProps {
  id: string; kind: 'claim' | 'ring'; status: IncidentStatus; title: string; released: boolean; confidence: number;
  independentSupport: number; rawItems: number; echoReduction: number; bestGrade: string | null; flags: string[];
  reasons: string[]; firstAt: number; lastAt: number; sharedIndicators: string[];
}
export interface GeoFeature<P> { type: 'Feature'; geometry: { type: 'Point'; coordinates: [number, number] } | { type: 'LineString'; coordinates: [number, number][] }; properties: P }
export interface IncidentCollection {
  type: 'FeatureCollection';
  features: GeoFeature<IncidentProps | { kind: 'link'; incident: string; status: IncidentStatus; reason: string; detail: string | null }>[];
  meta: { incidents: number; located: number; withoutLocation: { id: string; title: string; status: IncidentStatus }[]; store: string };
}
export interface HeatCollection { type: 'FeatureCollection'; features: GeoFeature<{ count: number }>[]; meta: { cell: number; cells: number; events: number; max: number; store: string } }
export interface CorroborationView {
  claim: string; rawSources: number; independentClusters: number; echoReduction: number;
  noisyOr: { support: number; contradiction: number; confidence: number };
  release: { allowed: boolean; reasons: string[] };
  gradeDistribution: Record<string, number>;
  members: { id: string; sourceId: string; sourceType: string; grade: string; stance: string; text: string; at: number; cluster: string }[];
  assessment: { phrase: string; flags: string[]; independentSupport: number; independentContradiction: number; rawSupportItems: number; links: { a: string; b: string; reason: string; detail?: string }[]; geoFlags: Record<string, { kind: string; place?: string; distanceKm?: number }[]>; clusters: { id: string; stance: string; members: string[]; weight: number; bestGrade: string }[] };
}
export interface AchResponse {
  result: {
    ranking: { id: string; label: string; inconsistency: number; consistency: number }[]; leader: string; margin: number;
    diagnosticity: { id: string; label: string; weight: number; diagnosticity: number }[];
    critical: { id: string; label: string; leaderWithoutIt: string }[]; nonDiagnostic: string[];
  };
  attribution: { allowed: boolean; reasons: string[]; leader: string };
}
export interface FusionStatus { store: string; queue: string; items: number; claims: number; geoipRows: number; ledgerWebhook: boolean; embedding?: { provider: string; dim: number; semantic: boolean; degraded?: string }; geoip?: { sources: string[] }; gazetteer?: { sources: string[] } }

/** Status colours: validated as a set against the dark surface for colour-vision deficiency; always paired with a shape and a label. */
export const STATUS: Record<IncidentStatus, { color: string; label: string; hint: string }> = {
  released: { color: '#199e70', label: 'Released', hint: 'corroborated by independent origins; passes the release rule' },
  quarantined: { color: '#c98500', label: 'Quarantined', hint: 'held back: unverified, single-source, echo or inconsistent' },
  ring: { color: '#9085e9', label: 'Ring', hint: 'accounts linked by shared wallet, device or address; for analyst review' },
};
