'use client';

import { createContext, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import { API, api, authHeaders, type CallRecord, type GateEvent, type PendingApproval } from './api';

export interface SessionLine { seq: number; at: number; sessionId: string; role: string; text: string }
interface State {
  connected: boolean;
  /** The server answered 401: it wants an API key this tab does not have (or has wrong). */
  authRequired: boolean;
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
  | { t: 'auth' }
  | { t: 'calls'; list: CallRecord[] }
  | { t: 'approvals'; list: PendingApproval[] };

const empty: State = { connected: false, authRequired: false, boot: null, lastSeq: 0, calls: [], approvals: [], lines: [], running: [], auditTick: 0, policyTick: 0, fusionTick: 0 };
const MAX_CALLS = 300;

function reduce(s: State, a: Action): State {
  if (a.t === 'conn') return { ...s, connected: a.up };
  if (a.t === 'auth') return { ...s, connected: false, authRequired: true };
  // Calls recorded before this page (or this server process) started: added behind what the live stream delivered.
  if (a.t === 'calls') {
    const have = new Set(s.calls.map(c => c.id));
    return { ...s, calls: [...s.calls, ...a.list.filter(c => !have.has(c.id))].sort((x, y) => y.at - x.at).slice(0, MAX_CALLS) };
  }
  if (a.t === 'approvals') return { ...s, approvals: a.list };
  // A different boot id means the server restarted: its numbering starts over, so drop what we hold.
  if (a.t === 'hello') return a.boot === s.boot ? { ...s, connected: true, authRequired: false } : { ...empty, connected: true, boot: a.boot };
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

  const [keyTick, setKeyTick] = useState(0);
  useEffect(() => {
    const bump = () => setKeyTick(t => t + 1);
    window.addEventListener('admiralty-key-changed', bump);
    return () => window.removeEventListener('admiralty-key-changed', bump);
  }, []);

  // The stream is read with fetch rather than EventSource, because EventSource cannot send an Authorization header.
  useEffect(() => {
    const ctl = new AbortController();
    let lastId = 0;
    let boot: string | null = null;
    const handle = (name: string, data: string, id: string): boolean => {
      if (name === 'hello') {
        const b = (JSON.parse(data) as { boot: string }).boot;
        // A restarted server numbers its events from 1 again: forget our position and reconnect from the start.
        const stale = boot !== null && boot !== b && lastId > 0;
        boot = b;
        if (stale) {
          lastId = 0;
          return false;
        }
        dispatch({ t: 'hello', boot: b });
        api<{ pending: PendingApproval[] }>('/api/approvals').then(r => dispatch({ t: 'approvals', list: r.pending }), () => undefined);
        api<{ calls: CallRecord[] }>('/api/calls?limit=200').then(r => dispatch({ t: 'calls', list: r.calls }), () => undefined);
      } else if (name === 'gate') {
        if (id) lastId = Number(id) || lastId;
        dispatch({ t: 'event', e: JSON.parse(data) as GateEvent });
      }
      return true;
    };
    (async () => {
      while (!ctl.signal.aborted) {
        try {
          const res = await fetch(`${API}/events`, { headers: { ...authHeaders(), ...(lastId ? { 'last-event-id': String(lastId) } : {}) }, signal: ctl.signal });
          if (res.status === 401) {
            dispatch({ t: 'auth' });
            return; // wait for a key; entering one restarts this effect
          }
          if (!res.ok || !res.body) throw new Error('stream unavailable');
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          let open = true;
          while (open) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i: number;
            while (open && (i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i).split('\n');
              buf = buf.slice(i + 2);
              const field = (k: string) => block.find(l => l.startsWith(`${k}: `))?.slice(k.length + 2) ?? '';
              const data = field('data');
              if (data) open = handle(field('event') || 'message', data, field('id'));
            }
          }
          if (!open) {
            await reader.cancel().catch(() => undefined);
            continue;
          }
        } catch {
          /* network error or abort: fall through to retry */
        }
        if (ctl.signal.aborted) return;
        dispatch({ t: 'conn', up: false });
        await new Promise(r => setTimeout(r, 1500));
      }
    })();
    return () => ctl.abort();
  }, [keyTick]);

  const value = useMemo(() => state, [state]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
