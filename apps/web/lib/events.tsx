'use client';

import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import { API, api, type CallRecord, type GateEvent, type PendingApproval } from './api';

export interface SessionLine { seq: number; at: number; sessionId: string; role: string; text: string }
interface State {
  connected: boolean;
  boot: string | null;
  lastSeq: number;
  calls: CallRecord[];
  approvals: PendingApproval[];
  lines: SessionLine[];
  running: string[];
  auditTick: number;
  policyTick: number;
  /** Bumps when provenance is ingested or an incident is recomputed. */
  fusionTick: number;
}
type Action =
  | { t: 'event'; e: GateEvent }
  | { t: 'hello'; boot: string }
  | { t: 'conn'; up: boolean }
  | { t: 'approvals'; list: PendingApproval[] };

const empty: State = { connected: false, boot: null, lastSeq: 0, calls: [], approvals: [], lines: [], running: [], auditTick: 0, policyTick: 0, fusionTick: 0 };
const MAX_CALLS = 300;

function reduce(s: State, a: Action): State {
  if (a.t === 'conn') return { ...s, connected: a.up };
  if (a.t === 'approvals') return { ...s, approvals: a.list };
  // A different boot id means the server restarted: its numbering starts over, so drop what we hold.
  if (a.t === 'hello') return a.boot === s.boot ? { ...s, connected: true } : { ...empty, connected: true, boot: a.boot };
  const e = a.e;
  if (e.seq <= s.lastSeq) return s;
  const n: State = { ...s, lastSeq: e.seq };
  const call = e.data?.call as CallRecord | undefined;
  if (call) {
    const i = n.calls.findIndex(c => c.id === call.id);
    n.calls = i >= 0 ? n.calls.map(c => (c.id === call.id ? call : c)) : [call, ...n.calls].slice(0, MAX_CALLS);
  }
  switch (e.type) {
    case 'approval.requested': {
      const ap = e.data.approval as PendingApproval;
      if (!n.approvals.some(x => x.id === ap.id)) n.approvals = [...n.approvals, ap];
      break;
    }
    case 'approval.resolved':
      n.approvals = n.approvals.filter(x => x.id !== e.data.id);
      break;
    case 'session.started':
      n.running = [...n.running, e.data.sessionId as string];
      n.lines = [...n.lines, { seq: e.seq, at: e.at, sessionId: e.data.sessionId as string, role: 'system', text: `Session started (${String(e.data.mode)}${e.data.scenarioId ? `: ${String(e.data.scenarioId)}` : ''})` }].slice(-200);
      break;
    case 'session.finished':
      n.running = n.running.filter(x => x !== e.data.sessionId);
      n.lines = [...n.lines, { seq: e.seq, at: e.at, sessionId: e.data.sessionId as string, role: e.data.error ? 'error' : 'system', text: e.data.error ? `Session failed: ${String(e.data.error)}` : `Session finished (${String(e.data.outcome ?? 'done')})` }].slice(-200);
      break;
    case 'session.message':
      n.lines = [...n.lines, { seq: e.seq, at: e.at, sessionId: e.data.sessionId as string, role: e.data.role as string, text: e.data.text as string }].slice(-200);
      break;
    case 'audit.appended':
    case 'audit.tampered':
    case 'audit.restored':
      n.auditTick = s.auditTick + 1;
      break;
    case 'incident.updated':
    case 'fusion.ingested':
      n.fusionTick = s.fusionTick + 1;
      break;
    case 'policy.updated':
      n.policyTick = s.policyTick + 1;
      break;
  }
  return n;
}

const Ctx = createContext<State>(empty);
export const useGate = (): State => useContext(Ctx);

export function EventsProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, empty);

  useEffect(() => {
    const es = new EventSource(`${API}/events`);
    es.addEventListener('hello', ev => {
      dispatch({ t: 'hello', boot: (JSON.parse((ev as MessageEvent<string>).data) as { boot: string }).boot });
      // The server's list is the authority on what is still waiting for an answer.
      api<{ pending: PendingApproval[] }>('/api/approvals').then(r => dispatch({ t: 'approvals', list: r.pending }), () => undefined);
    });
    es.addEventListener('gate', ev => dispatch({ t: 'event', e: JSON.parse((ev as MessageEvent<string>).data) as GateEvent }));
    es.onerror = () => dispatch({ t: 'conn', up: false });
    return () => es.close();
  }, []);

  const value = useMemo(() => state, [state]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
