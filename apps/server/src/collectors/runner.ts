/**
 * Runs a configured source through the collector MCP server, with McpGateProxy in between.
 *
 *   this process (MCP client) ──► McpGateProxy ──► collector child process
 *
 * The only trusted text is the operator's own configuration (the source's URL or path). A call for anything else
 * is "unknown" to the gate and is not forwarded. What comes back is untrusted by construction.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { McpGateProxy, gradeString, parseGrade, type AuditLog, type Decision, type GateConfig, type RpcMessage } from 'admiralty-gate';
import type { RawItem } from '../fusion/service.js';
import type { SourceType } from '../fusion/types.js';
import type { CollectedItem } from './parse.js';

export type CollectorType = 'feed' | 'telegram-export' | 'jsonl';
export interface CollectorSource {
  id: string;
  type: CollectorType;
  /** URL (feed) or file path (exports). */
  location: string;
  /** Admiralty grade given to everything this source yields. */
  grade: string;
  owner?: string;
  /** Attach every item to this incident key. */
  claim?: string;
}

const TOOL: Record<CollectorType, { tool: string; arg: string; sourceType: SourceType }> = {
  feed: { tool: 'collect_feed', arg: 'url', sourceType: 'feed' },
  'telegram-export': { tool: 'collect_telegram_export', arg: 'path', sourceType: 'telegram' },
  jsonl: { tool: 'collect_jsonl', arg: 'path', sourceType: 'tool' },
};

export function parseCollectorConfig(v: unknown): CollectorSource[] {
  const fail = (m: string): never => {
    throw new Error(`Invalid collectors config: ${m}`);
  };
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('top level must be {"sources": [...]}');
  const list = (v as { sources?: unknown }).sources;
  if (!Array.isArray(list)) fail('"sources" must be an array');
  const seen = new Set<string>();
  return (list as unknown[]).map((s, i) => {
    const o = s as Record<string, unknown>;
    if (!o || typeof o !== 'object') fail(`sources[${i}] must be an object`);
    for (const k of Object.keys(o)) if (!['id', 'type', 'location', 'grade', 'owner', 'claim', '$comment'].includes(k)) fail(`sources[${i}] has unknown key "${k}"`);
    if (typeof o.id !== 'string' || !/^[\w.-]{1,64}$/.test(o.id)) fail(`sources[${i}].id must be 1-64 letters, digits, ".", "_" or "-"`);
    if (seen.has(o.id as string)) fail(`duplicate source id "${String(o.id)}"`);
    seen.add(o.id as string);
    if (!Object.hasOwn(TOOL, o.type as string)) fail(`sources[${i}].type must be one of ${Object.keys(TOOL).join(', ')}`);
    if (typeof o.location !== 'string' || !o.location.trim()) fail(`sources[${i}].location must be a URL or a path`);
    let grade = 'F6';
    if (o.grade !== undefined) {
      try {
        grade = gradeString(parseGrade(String(o.grade)));
      } catch (e) {
        fail(`sources[${i}].grade: ${(e as Error).message}`);
      }
    }
    return {
      id: o.id as string, type: o.type as CollectorType, location: (o.location as string).trim(), grade,
      ...(typeof o.owner === 'string' && o.owner ? { owner: o.owner } : {}),
      ...(typeof o.claim === 'string' && o.claim ? { claim: o.claim } : {}),
    };
  });
}

/** Gate policy for the collector tools: fetching is an infrastructure lookup whose target must be operator-supplied. */
export const collectorGateConfig = (): GateConfig => ({
  tools: {
    collect_feed: { tier: 'lookup-infra', targetArgs: ['url'] },
    collect_telegram_export: { tier: 'lookup-infra', targetArgs: ['path'] },
    collect_jsonl: { tier: 'lookup-infra', targetArgs: ['path'] },
  },
  // Nobody is watching a scheduled collection run, so anything not plainly configured is refused, not queued.
  onUnknownInfra: 'deny',
  onTaintedInfra: 'deny',
});

/** How to start the collector: compiled JS in production, the TypeScript source under tsx in development and tests. */
export function collectorCommand(): { command: string; args: string[] } {
  const self = fileURLToPath(import.meta.url);
  const ts = self.endsWith('.ts');
  const script = fileURLToPath(new URL(ts ? './mcp-server.ts' : './mcp-server.js', import.meta.url));
  return { command: process.execPath, args: ts ? ['--import', 'tsx', script] : [script] };
}

export interface CollectResult {
  source: CollectorSource;
  decision: Decision;
  items: RawItem[];
  error?: string;
}

export interface RunOptions {
  audit?: AuditLog;
  /** Override what is called (tests: prove a non-configured location is refused). Default: the source's own location. */
  call?: { tool: string; args: Record<string, unknown> };
  command?: { command: string; args: string[] };
  timeoutMs?: number;
}

export function runCollector(source: CollectorSource, o: RunOptions = {}): Promise<CollectResult> {
  const spec = TOOL[source.type];
  const call = o.call ?? { tool: spec.tool, args: { [spec.arg]: source.location } };
  const cmd = o.command ?? collectorCommand();
  const child = spawn(cmd.command, cmd.args, { stdio: ['pipe', 'pipe', 'inherit'] });

  return new Promise<CollectResult>(resolve => {
    let decision: Decision | undefined;
    let done = false;
    const finish = (r: Omit<CollectResult, 'source' | 'decision'>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve({ source, decision: decision ?? { verdict: 'deny', tool: call.tool, tier: 'unregistered', reasons: ['no decision was reached'], traces: {} }, ...r });
    };
    const timer = setTimeout(() => finish({ items: [], error: 'collector timed out' }), o.timeoutMs ?? 30000);

    const proxy = new McpGateProxy({
      config: collectorGateConfig(),
      trusted: [source.location],
      serverName: `collector:${source.id}`,
      ...(o.audit ? { audit: o.audit } : {}),
      onDecision: d => {
        decision = d;
      },
      toServer: m => child.stdin.write(JSON.stringify(m) + '\n'),
      toClient: (m: RpcMessage) => {
        if (m.id !== 2) return;
        const r = (m.result ?? {}) as { isError?: boolean; content?: { text?: string }[] };
        const text = r.content?.[0]?.text ?? '';
        if (r.isError) return finish({ items: [], error: text });
        let parsed: CollectedItem[];
        try {
          parsed = JSON.parse(text) as CollectedItem[];
        } catch {
          return finish({ items: [], error: 'collector returned something that is not JSON' });
        }
        finish({
          items: parsed.map(c => ({
            ...c,
            sourceType: spec.sourceType,
            sourceId: source.id,
            grade: source.grade,
            ...(c.owner ?? source.owner ? { owner: c.owner ?? source.owner! } : {}),
            ...(c.claim ?? source.claim ? { claim: c.claim ?? source.claim! } : {}),
          })),
        });
      },
    });

    child.on('error', e => finish({ items: [], error: `cannot start collector: ${e.message}` }));
    child.on('exit', () => finish({ items: [], error: 'collector exited before answering' }));
    child.stdin.on('error', () => undefined);
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        proxy.onServerMessage(JSON.parse(line) as RpcMessage);
      } catch {
        /* not JSON-RPC: ignored */
      }
    });
    proxy.onClientMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } });
    proxy.onClientMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: call.tool, arguments: call.args } });
  });
}
