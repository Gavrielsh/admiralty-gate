/**
 * MCP gate proxy: put the gate between ANY Model Context Protocol client
 * (a desktop assistant, an IDE agent, a custom host) and ANY MCP server,
 * without changing either. The proxy speaks newline-delimited JSON-RPC on
 * both sides and intercepts exactly one thing: `tools/call`.
 *
 *   client ──► proxy ──► server
 *                │  tools/call  -> Gate.decide()
 *                │      allow             forward
 *                │      require_approval  ask the HUMAN via MCP elicitation (if the client supports it), else block
 *                │      deny              answer with an error result; the server never sees the call
 *                └─ every tool result, resource, prompt and tool description coming back from the server is
 *                   recorded as UNTRUSTED provenance before the client's model reads it.
 *
 * Trust model: the proxy cannot see what the user typed to the client. So
 * the only trusted text is what the operator put in the policy (`trusted`)
 * or passed through `addTrusted` (the CLI's
 * --operator-file). Everything else is "tainted" (seen in server output) or
 * "unknown" (never seen), and sensitive tiers then need a human approval.
 *
 * This class is transport-free (messages in, messages out) so it can be
 * tested without processes; `runStdioProxy` wires it to a child process.
 */
import { AuditLog } from '../audit.js';
import { Gate, scalarLeaves, type Decision, type GateConfig, type ToolCall } from '../guard.js';
import { ProvenanceLedger } from '../provenance.js';
import { sanitiseUntrusted } from '../text.js';

type Id = string | number;
export interface RpcMessage {
  jsonrpc?: string;
  id?: Id | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface McpProxyOptions {
  config: GateConfig;
  /** Operator-vouched text (from the policy). */
  trusted?: readonly string[];
  toClient: (msg: RpcMessage) => void;
  toServer: (msg: RpcMessage) => void;
  audit?: AuditLog;
  /** Name used for the origin id of everything the server returns. */
  serverName?: string;
  /** How long to wait for a human answer before treating it as "no". Default 5 minutes. */
  approvalTimeoutMs?: number;
  onDecision?: (d: Decision, call: ToolCall) => void;
}

const key = (id: Id): string => `${typeof id}:${id}`;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** All human-readable text inside an MCP result (content blocks, structured content, resources, prompt messages). */
export function mcpText(result: unknown): string {
  return scalarLeaves(result).map(String).join('\n');
}

export class McpGateProxy {
  readonly ledger = new ProvenanceLedger();
  readonly audit: AuditLog;
  readonly gate: Gate;
  private clientElicits = false;
  private seq = 0;
  private readonly server: string;
  /** Requests forwarded to the server whose responses must be recorded: id -> label. */
  private readonly watching = new Map<string, string>();
  private readonly approvals = new Map<string, { call: RpcMessage; tool: string; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly o: McpProxyOptions) {
    this.audit = o.audit ?? new AuditLog();
    this.gate = new Gate(this.ledger, o.config, this.audit);
    this.server = o.serverName ?? 'mcp-server';
    for (const t of o.trusted ?? []) this.ledger.addTrusted(t);
  }

  /** Out-of-band operator input (never reachable from the model). */
  addTrusted(text: string): void {
    this.ledger.addTrusted(text);
  }

  onClientMessage(msg: RpcMessage | RpcMessage[]): void {
    if (Array.isArray(msg)) return msg.forEach(m => this.onClientMessage(m));
    const isRequest = typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null;

    // A response from the client: ours (approval answer) or the server's.
    if (msg.method === undefined && msg.id !== undefined && msg.id !== null) {
      const pending = this.approvals.get(key(msg.id));
      if (!pending) return this.o.toServer(msg);
      const r = obj(msg.result);
      this.resolveApproval(key(msg.id), r.action === 'accept' && obj(r.content).approve === true);
      return;
    }

    if (isRequest && msg.method === 'initialize') {
      this.clientElicits = 'elicitation' in obj(obj(msg.params).capabilities);
    } else if (isRequest && msg.method === 'tools/call') {
      return this.gateCall(msg);
    } else if (isRequest && (msg.method === 'tools/list' || msg.method === 'resources/read' || msg.method === 'prompts/get')) {
      this.watching.set(key(msg.id as Id), msg.method!);
    }
    this.o.toServer(msg);
  }

  onServerMessage(msg: RpcMessage | RpcMessage[]): void {
    if (Array.isArray(msg)) return msg.forEach(m => this.onServerMessage(m));
    if (msg.method === undefined && msg.id !== undefined && msg.id !== null) {
      const label = this.watching.get(key(msg.id));
      if (label !== undefined) {
        this.watching.delete(key(msg.id));
        const text = mcpText(msg.result ?? msg.error);
        if (text) this.ledger.addUntrusted(text, { id: `${this.server}:${label}`, kind: 'tool' });
      }
    } else if (msg.method === 'sampling/createMessage') {
      // The server is asking the client's model to read text of the server's choosing.
      const text = mcpText(msg.params);
      if (text) this.ledger.addUntrusted(text, { id: `${this.server}:sampling`, kind: 'tool' });
    }
    this.o.toClient(msg);
  }

  /** Call when the transport closes: outstanding approvals are answered "no". */
  close(): void {
    for (const k of [...this.approvals.keys()]) this.resolveApproval(k, false);
  }

  private gateCall(msg: RpcMessage): void {
    const p = obj(msg.params);
    const tool = typeof p.name === 'string' ? p.name : '';
    const call: ToolCall = { tool, args: obj(p.arguments) };
    const d = this.gate.decide(call);
    this.o.onDecision?.(d, call);

    if (d.verdict === 'allow') return this.forwardCall(msg, tool);
    if (d.verdict === 'deny') return this.block(msg, d, 'denied');
    if (!this.clientElicits) {
      this.audit.append('approval', { tool, approved: false, why: 'client cannot ask a human (no elicitation capability)' });
      return this.block(msg, d, 'needs human approval, and this client offers no way to ask for it');
    }

    const id = `admiralty-gate-approval-${++this.seq}`;
    const timer = setTimeout(() => this.resolveApproval(key(id), false), this.o.approvalTimeoutMs ?? 300_000);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.approvals.set(key(id), { call: msg, tool, timer });
    this.pendingDecisions.set(key(id), d);
    this.o.toClient({
      jsonrpc: '2.0',
      id,
      method: 'elicitation/create',
      params: {
        message: approvalMessage(d, call),
        requestedSchema: {
          type: 'object',
          properties: { approve: { type: 'boolean', title: 'Run this tool call', description: 'Approve only if YOU asked for this action.' } },
          required: ['approve'],
        },
      },
    });
  }

  private readonly pendingDecisions = new Map<string, Decision>();

  private resolveApproval(k: string, approved: boolean): void {
    const pending = this.approvals.get(k);
    const d = this.pendingDecisions.get(k);
    if (!pending || !d) return;
    clearTimeout(pending.timer);
    this.approvals.delete(k);
    this.pendingDecisions.delete(k);
    this.audit.append('approval', { tool: pending.tool, approved });
    if (approved) this.forwardCall(pending.call, pending.tool);
    else this.block(pending.call, d, 'a human did not approve it');
  }

  private forwardCall(msg: RpcMessage, tool: string): void {
    this.watching.set(key(msg.id as Id), tool);
    this.o.toServer(msg);
  }

  private block(msg: RpcMessage, d: Decision, why: string): void {
    this.o.toClient({
      jsonrpc: '2.0',
      id: msg.id as Id,
      result: {
        isError: true,
        content: [{ type: 'text', text: `Blocked by admiralty-gate (${why}). Tier: ${d.tier}. ${d.reasons.join('; ')}` }],
      },
    });
  }
}

/** The text shown to the human. Argument values may be attacker-written, so they are cleaned, quoted and truncated. */
export function approvalMessage(d: Decision, call: ToolCall): string {
  const show = (v: unknown): string => {
    const s = sanitiseUntrusted(scalarLeaves(v).map(String).join(', ')).clean.replace(/\s+/g, ' ');
    return JSON.stringify(s.length > 160 ? `${s.slice(0, 160)}...` : s);
  };
  const args = Object.entries(call.args)
    .slice(0, 12)
    .map(([k, v]) => `  ${JSON.stringify(k.slice(0, 40))} = ${show(v)}  [${d.traces[k] ?? 'not traced'}]`)
    .join('\n');
  return [
    `The assistant wants to run the tool ${JSON.stringify(call.tool.slice(0, 80))} (risk tier: ${d.tier}).`,
    args,
    `Why you are being asked: ${d.reasons.join('; ')}.`,
    'A "tainted" value came from content the assistant read, not from you. Approve only if you asked for this.',
  ]
    .filter(Boolean)
    .join('\n');
}
