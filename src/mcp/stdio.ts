/**
 * Stdio wiring for McpGateProxy: this process is the MCP "server" the client
 * launches; it launches the real server as a child and relays
 * newline-delimited JSON-RPC both ways through the gate.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { AuditLog } from '../audit.js';
import type { Policy } from '../policy.js';
import { McpGateProxy, type RpcMessage } from './proxy.js';

export interface StdioProxyOptions {
  policy: Policy;
  command: string;
  args: readonly string[];
  /** JSONL file for the hash-chained audit log. */
  auditFile?: string;
  /**
   * A file only the operator can write. Each line is trusted operator text; it is re-read before every decision, so
   * the operator can authorise a target mid-session from a separate terminal: `echo "bob_77" >> operator.txt`.
   */
  operatorFile?: string;
  stdin?: Readable;
  stdout?: Writable;
  log?: (line: string) => void;
}

function lines(stream: Readable, onMessage: (m: RpcMessage | RpcMessage[]) => void, log: (s: string) => void): void {
  createInterface({ input: stream, crlfDelay: Infinity }).on('line', line => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      // Not JSON-RPC: never forwarded. A server printing banners to stdout is a server bug, not something to relay.
      return log(`dropped non-JSON line (${line.length} bytes)`);
    }
    if (msg && typeof msg === 'object') onMessage(msg as RpcMessage | RpcMessage[]);
  });
}

/** Resolves with the child's exit code when either side closes. */
export function runStdioProxy(o: StdioProxyOptions): Promise<number> {
  const stdin = o.stdin ?? process.stdin;
  const stdout = o.stdout ?? process.stdout;
  const log = o.log ?? (s => process.stderr.write(`[admiralty-gate] ${s}\n`));
  const child = spawn(o.command, [...o.args], { stdio: ['pipe', 'pipe', 'inherit'] });
  const write = (w: Writable, m: RpcMessage) => {
    if (!w.destroyed && w.writable) w.write(JSON.stringify(m) + '\n');
  };

  let operatorLines = 0;
  const proxy = new McpGateProxy({
    config: o.policy.config,
    trusted: o.policy.trusted,
    serverName: o.command.split(/[\\/]/).pop() ?? 'mcp-server',
    toClient: m => write(stdout, m),
    toServer: m => write(child.stdin, m),
    ...(o.auditFile ? { audit: AuditLog.file(o.auditFile) } : {}),
    onDecision: (d, call) => log(`${d.verdict.toUpperCase()} ${call.tool} [${d.tier}] ${d.reasons.join('; ')}`),
  });
  const syncOperator = () => {
    if (!o.operatorFile || !existsSync(o.operatorFile)) return;
    const all = readFileSync(o.operatorFile, 'utf8').split('\n').filter(l => l.trim());
    for (const l of all.slice(operatorLines)) proxy.addTrusted(l);
    operatorLines = all.length;
  };

  lines(stdin, m => {
    syncOperator();
    proxy.onClientMessage(m);
  }, log);
  lines(child.stdout, m => proxy.onServerMessage(m), log);

  return new Promise(resolve => {
    stdin.on('end', () => {
      proxy.close();
      child.stdin.end();
    });
    child.stdin.on('error', () => undefined);
    child.on('error', e => {
      log(`cannot start server: ${e.message}`);
      resolve(127);
    });
    child.on('exit', code => {
      proxy.close();
      resolve(code ?? 1);
    });
  });
}
