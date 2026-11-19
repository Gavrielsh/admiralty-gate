/**
 * GuardedSession: the whole library behind one object, for ANY tool-calling
 * agent loop (Anthropic tool_use, OpenAI tool_calls, LangChain, a home-made
 * loop). It owns the provenance ledger, the gate and the audit log, and keeps
 * the one invariant that matters:
 *
 *   everything the model reads that the operator did not type is recorded as
 *   untrusted BEFORE the model can lift an argument out of it.
 *
 * Usage:
 *   const s = new GuardedSession(config, { approve: askHuman });
 *   s.operatorSays(userMessage);                    // trusted
 *   s.observe(pageText, { id: 'example.org', kind: 'web' });   // untrusted
 *   const r = await s.call({ tool, args }, runTool);           // gated; result recorded as untrusted
 */
import { randomBytes } from 'node:crypto';
import { AuditLog } from './audit.js';
import { Gate, type Decision, type GateConfig, type ToolCall } from './guard.js';
import { ProvenanceLedger, type Origin, type Span } from './provenance.js';
import { fenceUntrusted } from './text.js';

export interface SessionOptions {
  /** Consulted for require_approval. Must reach a real human; default is "not approved". */
  approve?: (d: Decision, call: ToolCall) => Promise<boolean>;
  audit?: AuditLog;
  onDecision?: (d: Decision, call: ToolCall) => void;
  clock?: () => number;
}

export type CallOutcome<R> =
  | { executed: true; decision: Decision; result: R }
  | { executed: false; decision: Decision; /** Text to hand back to the model as the tool result. */ message: string };

/** Best-effort text of a tool result, for provenance. Strings pass through; everything else is JSON. */
export function resultText(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return v === undefined ? '' : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export class GuardedSession {
  readonly ledger: ProvenanceLedger;
  readonly audit: AuditLog;
  readonly gate: Gate;
  private readonly nonce = randomBytes(8).toString('hex');

  constructor(
    cfg: GateConfig,
    private readonly opts: SessionOptions = {},
  ) {
    this.ledger = new ProvenanceLedger(opts.clock);
    this.audit = opts.audit ?? new AuditLog(opts.clock);
    this.gate = new Gate(this.ledger, cfg, this.audit);
  }

  /** Record text typed by the authenticated operator in this session. Only this can authorise sensitive actions. */
  operatorSays(text: string): Span {
    return this.ledger.addTrusted(text);
  }

  /** Record anything else the model will read: web pages, feed items, files, retrieved documents. */
  observe(text: string, origin: Origin): Span {
    return this.ledger.addUntrusted(text, origin);
  }

  /** `observe` plus a per-session random fence around the text, ready to place in the prompt (defence in depth). */
  observeFenced(text: string, origin: Origin): string {
    this.observe(text, origin);
    return fenceUntrusted(text, `${origin.kind}:${origin.id}`, this.nonce);
  }

  /** Gate a proposed call; run it if permitted; record its result as untrusted. */
  async call<R>(call: ToolCall, exec: (call: ToolCall) => Promise<R>): Promise<CallOutcome<R>> {
    const decision = this.gate.decide(call);
    this.opts.onDecision?.(decision, call);
    let allowed = decision.verdict === 'allow';
    if (decision.verdict === 'require_approval') {
      allowed = this.opts.approve ? (await this.opts.approve(decision, call)) === true : false;
      this.audit.append('approval', { tool: call.tool, approved: allowed });
    }
    if (!allowed) {
      return { executed: false, decision, message: `Blocked by policy (${decision.verdict}): ${decision.reasons.join('; ')}` };
    }
    const result = await exec(call);
    this.ledger.addUntrusted(resultText(result), { id: call.tool, kind: 'tool' });
    return { executed: true, decision, result };
  }

  /**
   * Wrap a map of tool functions so each goes through the gate. A blocked call resolves to
   * `{ blocked: true, message }` instead of throwing, so the loop can return it to the model as data.
   */
  wrap<T extends Record<string, (args: Record<string, unknown>) => Promise<unknown>>>(
    tools: T,
  ): { [K in keyof T]: (args: Record<string, unknown>) => Promise<Awaited<ReturnType<T[K]>> | { blocked: true; message: string }> } {
    const out: Record<string, unknown> = {};
    for (const name of Object.keys(tools)) {
      out[name] = async (args: Record<string, unknown>) => {
        const r = await this.call({ tool: name, args }, c => tools[name]!(c.args));
        return r.executed ? r.result : { blocked: true as const, message: r.message };
      };
    }
    return out as never;
  }
}

/** Anthropic Messages API `tool_use` content block -> ToolCall. */
export function fromAnthropicToolUse(block: { name: string; input: unknown }): ToolCall {
  return { tool: block.name, args: block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {} };
}

/**
 * OpenAI-style tool call (`function.arguments` is a JSON string) -> ToolCall. Unparseable arguments become a single
 * opaque argument, which traces as "unknown" and therefore fails closed on sensitive tiers.
 */
export function fromOpenAiToolCall(tc: { function: { name: string; arguments: string } }): ToolCall {
  let args: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(tc.function.arguments || '{}');
    args = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { _raw: tc.function.arguments };
  } catch {
    args = { _raw: tc.function.arguments };
  }
  return { tool: tc.function.name, args };
}
