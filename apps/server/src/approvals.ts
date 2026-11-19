/**
 * Human-in-the-loop queue. A gated call that needs approval parks a promise here; the browser resolves it through
 * POST /api/approvals/:id. Anything other than an explicit approve (deny, timeout, shutdown) resolves to false.
 */
import type { EventBus } from './bus.js';
import type { CallRecord } from './calls.js';
import type { ApprovalRow } from './fusion/types.js';

export interface PendingApproval {
  id: string;
  callId: string;
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  tier?: string;
  reasons: string[];
  provenance: CallRecord['provenance'];
  requestedAt: number;
  expiresAt: number;
}

export class ApprovalQueue {
  private n = 0;
  private readonly pending = new Map<string, { info: PendingApproval; rec: CallRecord; settle: (ok: boolean) => void; timer: NodeJS.Timeout }>();

  constructor(
    private readonly bus: EventBus,
    private readonly timeoutMs = 300_000,
    private readonly clock: () => number = () => Date.now(),
    private readonly idPrefix = 'apr_',
    /** Called when an approval is requested and again when it is settled, so the record outlives the process. */
    private readonly onChange: (row: ApprovalRow) => void = () => undefined,
  ) {}

  private row(info: PendingApproval, state: ApprovalRow['state']): ApprovalRow {
    return { ...info, state, ...(state === 'pending' ? {} : { resolvedAt: this.clock() }) };
  }

  request(rec: CallRecord): Promise<boolean> {
    const id = `${this.idPrefix}${++this.n}`;
    const now = this.clock();
    const info: PendingApproval = {
      id, callId: rec.id, sessionId: rec.sessionId, tool: rec.tool, args: rec.args, reasons: rec.reasons,
      provenance: rec.provenance, requestedAt: now, expiresAt: now + this.timeoutMs,
      ...(rec.tier ? { tier: rec.tier } : {}),
    };
    rec.status = 'awaiting_approval';
    rec.approval = { id, state: 'pending' };
    return new Promise<boolean>(settle => {
      const timer = setTimeout(() => this.finish(id, 'timeout'), this.timeoutMs);
      timer.unref();
      this.pending.set(id, { info, rec, settle, timer });
      this.onChange(this.row(info, 'pending'));
      this.bus.emit('approval.requested', { approval: info, call: rec });
    });
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].map(p => p.info);
  }

  /** Returns false when there is no such pending approval (unknown id, already answered, or timed out). */
  resolve(id: string, approve: boolean): boolean {
    return this.finish(id, approve ? 'approved' : 'denied');
  }

  /** Server shutdown: everything still waiting is answered "no". */
  denyAll(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, 'denied');
  }

  private finish(id: string, state: 'approved' | 'denied' | 'timeout'): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.rec.approval = { id, state };
    this.onChange(this.row(p.info, state));
    this.bus.emit('approval.resolved', { id, state, callId: p.rec.id, call: p.rec });
    p.settle(state === 'approved');
    return true;
  }
}
