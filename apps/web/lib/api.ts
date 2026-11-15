export const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4319';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: init?.method ?? 'GET',
      ...(init?.body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) } : {}),
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
  text: string; status: string; level: 'operator' | 'verified' | 'single' | 'weak' | 'ungrounded'; overlap: number;
  support: { spanId: string; origin: { id: string; kind: string }; overlap: number }[]; independentOrigins: number;
  bestGrade?: string; unsupportedSpecifics: string[]; fromFlaggedSource: boolean;
}
export interface GroundingResult {
  sentences: GroundedSentence[];
  summary: { sentences: number; operator: number; grounded: number; weak: number; ungrounded: number; singleOrigin: number; withUnsupportedSpecifics: number };
  sources: { spanId: string; id: string; kind: string; grade?: string; trusted: boolean; text: string }[];
}
