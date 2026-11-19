/**
 * CallRecord: everything the dashboard shows about one intercepted tool call, built from the gate's Decision.
 * The record is a view; the gate's decision is the authority.
 */
import { isAuthorisedHost, isSingleHost, scalarLeaves, type Decision, type ProvenanceLedger, type ToolCall } from 'admiralty-gate';
import type { EventBus } from './bus.js';

export type ProvenanceLabel = 'OPERATOR' | 'UNTRUSTED_TOOL_OUTPUT' | 'UNTRUSTED_SOURCE' | 'UNKNOWN';
export interface ArgProvenance {
  arg: string;
  value: string;
  label: ProvenanceLabel;
  origins: string[];
}
export interface HostCheck {
  arg: string;
  value: string;
  result: 'authorised' | 'not-authorised' | 'not-a-single-host';
}
export type GateOutcome = 'ALLOW' | 'BLOCK' | 'ELICIT';
export interface CallRecord {
  id: string;
  sessionId: string;
  source: 'sandbox' | 'mcp-proxy' | 'mcp-bridge';
  at: number;
  tool: string;
  args: Record<string, unknown>;
  tier?: string;
  gate?: GateOutcome;
  reasons: string[];
  provenance: ArgProvenance[];
  hostChecks: HostCheck[];
  status: 'intercepted' | 'awaiting_approval' | 'executed' | 'blocked';
  approval?: { id: string; state: 'pending' | 'approved' | 'denied' | 'timeout' };
  result?: string;
}

const GATE: Record<Decision['verdict'], GateOutcome> = { allow: 'ALLOW', deny: 'BLOCK', require_approval: 'ELICIT' };
const clip = (s: string, n = 400): string => (s.length > n ? `${s.slice(0, n)}...` : s);

export class CallTracker {
  private n = 0;
  constructor(
    private readonly bus: EventBus,
    private readonly clock: () => number = () => Date.now(),
    private readonly idPrefix = 'call_',
    /** Called with the record every time it changes, so it can be stored. */
    private readonly onChange: (rec: CallRecord) => void = () => undefined,
  ) {}

  intercept(sessionId: string, source: CallRecord['source'], call: ToolCall): CallRecord {
    const rec: CallRecord = {
      id: `${this.idPrefix}${++this.n}`, sessionId, source, at: this.clock(), tool: call.tool, args: call.args,
      reasons: [], provenance: [], hostChecks: [], status: 'intercepted',
    };
    this.bus.emit('tool.intercepted', { call: rec });
    this.onChange(rec);
    return rec;
  }

  /** Fill in the gate's decision. `ledger` (when this process owns it) adds which origins a tainted value came from. */
  decided(rec: CallRecord, d: Decision, authorisedTargets: readonly string[], ledger?: ProvenanceLedger): void {
    rec.tier = d.tier;
    rec.gate = GATE[d.verdict];
    rec.reasons = d.reasons;
    for (const [arg, cls] of Object.entries(d.traces)) {
      const leaves = scalarLeaves(rec.args[arg]).map(String);
      const origins = new Set<string>();
      let onlyTools = true;
      if (ledger)
        for (const leaf of leaves)
          for (const o of ledger.trace(leaf).origins) {
            origins.add(`${o.kind}:${o.id}`);
            if (o.kind !== 'tool') onlyTools = false;
          }
      const label: ProvenanceLabel =
        cls === 'trusted' ? 'OPERATOR' : cls === 'unknown' ? 'UNKNOWN' : onlyTools ? 'UNTRUSTED_TOOL_OUTPUT' : 'UNTRUSTED_SOURCE';
      const p: ArgProvenance = { arg, value: clip(leaves.join(', '), 200), label, origins: [...origins] };
      rec.provenance.push(p);
      if (cls === 'tainted') this.bus.emit('argument.tainted', { callId: rec.id, ...p });
      if (d.tier === 'active-probe')
        for (const leaf of leaves) {
          const h: HostCheck = {
            arg, value: clip(leaf, 200),
            result: !isSingleHost(leaf) ? 'not-a-single-host' : isAuthorisedHost(leaf, authorisedTargets) ? 'authorised' : 'not-authorised',
          };
          rec.hostChecks.push(h);
          this.bus.emit(h.result === 'authorised' ? 'host.check.passed' : 'host.check.failed', { callId: rec.id, ...h });
        }
    }
    this.bus.emit('tool.decision', { call: rec });
    this.onChange(rec);
  }

  finish(rec: CallRecord, executed: boolean, result?: string): void {
    rec.status = executed ? 'executed' : 'blocked';
    if (result !== undefined) rec.result = clip(result);
    this.bus.emit(executed ? 'tool.executed' : 'tool.blocked', { call: rec });
    this.onChange(rec);
  }
}
