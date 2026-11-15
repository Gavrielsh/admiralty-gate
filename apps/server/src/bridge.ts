/**
 * MCP bridge: run a REAL MCP server behind the gate, with the dashboard as the human-approval channel.
 * Decisions are reported to the dashboard; a call that needs approval waits for a click there.
 * If the dashboard cannot be reached, the answer is "no".
 */
import type { Readable, Writable } from 'node:stream';
import { parsePolicy, runStdioProxy, type Decision, type ToolCall } from 'admiralty-gate';

export interface BridgeOptions {
  dashboard: string;
  command: string;
  args: readonly string[];
  /** ADMIRALTY_API_KEY of the dashboard, when it requires one. */
  apiKey?: string;
  /** Policy JSON text; when omitted the dashboard's current policy is fetched. */
  policyJson?: string;
  stdin?: Readable;
  stdout?: Writable;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export async function runBridge(o: BridgeOptions): Promise<number> {
  const f = o.fetch ?? fetch;
  const base = o.dashboard.replace(/\/$/, '');
  const log = o.log ?? (s => process.stderr.write(`[admiralty-gate bridge] ${s}\n`));
  const auth: Record<string, string> = o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {};
  const policy = parsePolicy(o.policyJson ?? ((await (await f(`${base}/api/policy`, { headers: auth })).json()) as { policy: unknown }).policy);
  const server = o.command.split(/[\\/]/).pop() ?? 'mcp-server';
  const report = async (decision: Decision, call: ToolCall): Promise<boolean> => {
    try {
      const res = await f(`${base}/api/mcp/calls`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ server, call, decision }) });
      return res.ok && ((await res.json()) as { approved?: unknown }).approved === true;
    } catch (e) {
      log(`dashboard unreachable (${(e as Error).message}); treating as not approved`);
      return false;
    }
  };
  return runStdioProxy({
    policy, command: o.command, args: o.args, log,
    ...(o.stdin ? { stdin: o.stdin } : {}),
    ...(o.stdout ? { stdout: o.stdout } : {}),
    onDecision: (d, call) => {
      if (d.verdict !== 'require_approval') void report(d, call);
    },
    approve: report,
  });
}
