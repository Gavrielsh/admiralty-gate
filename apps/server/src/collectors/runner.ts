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
    telegram_poll: { tier: 'lookup-infra', targetArgs: ['channel'] },
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

export interface SessionCall {
  decision: Decision;
  /** The collector's answer (JSON text) when the gate let the call through and the collector succeeded. */
  text?: string;
  error?: string;
}

/**
 * A collector child process with McpGateProxy in front of it, kept open for several calls (a live stream polls
 * through it). Calls run one at a time. `trusted` is the only text that can authorise a target.
 */
export class CollectorSession {
  private readonly child: ReturnType<typeof spawn>;
  private readonly proxy: McpGateProxy;
  private seq = 1;
  private lastDecision: Decision | undefined;
  private readonly waiting = new Map<number, (r: { isError?: boolean; text: string }) => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private dead: string | undefined;

  constructor(o: { trusted: readonly string[]; name: string; audit?: AuditLog; command?: { command: string; args: string[] }; env?: NodeJS.ProcessEnv }) {
    const cmd = o.command ?? collectorCommand();
    this.child = spawn(cmd.command, cmd.args, { stdio: ['pipe', 'pipe', 'inherit'], ...(o.env ? { env: o.env } : {}) });
    this.proxy = new McpGateProxy({
      config: collectorGateConfig(),
      trusted: o.trusted,
      serverName: `collector:${o.name}`,
      ...(o.audit ? { audit: o.audit } : {}),
      onDecision: d => {
        this.lastDecision = d;
      },
      toServer: m => this.child.stdin!.write(JSON.stringify(m) + '\n'),
      toClient: (m: RpcMessage) => {
        const done = typeof m.id === 'number' ? this.waiting.get(m.id) : undefined;
        if (!done) return;
        this.waiting.delete(m.id as number);
        const r = (m.result ?? {}) as { isError?: boolean; content?: { text?: string }[] };
        done({ text: r.content?.[0]?.text ?? '', ...(r.isError ? { isError: true } : {}) });
      },
    });
    const fail = (why: string) => {
      this.dead = why;
      for (const done of this.waiting.values()) done({ isError: true, text: why });
      this.waiting.clear();
    };
    this.child.on('error', e => fail(`cannot start collector: ${e.message}`));
    this.child.on('exit', () => fail('collector exited before answering'));
    this.child.stdin!.on('error', () => undefined);
    createInterface({ input: this.child.stdout! }).on('line', line => {
      try {
        this.proxy.onServerMessage(JSON.parse(line) as RpcMessage);
      } catch {
        /* not JSON-RPC: ignored */
      }
    });
    this.proxy.onClientMessage({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities: {} } });
  }

  call(tool: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<SessionCall> {
    const run = async (): Promise<SessionCall> => {
      const none: Decision = { verdict: 'deny', tool, tier: 'unregistered', reasons: ['no decision was reached'], traces: {} };
      if (this.dead) return { decision: none, error: this.dead };
      const id = ++this.seq;
      this.lastDecision = undefined;
      const answer = new Promise<{ isError?: boolean; text: string }>(resolve => {
        this.waiting.set(id, resolve);
        const timer = setTimeout(() => {
          if (this.waiting.delete(id)) resolve({ isError: true, text: 'collector timed out' });
        }, timeoutMs);
        timer.unref();
      });
      this.proxy.onClientMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } });
      const r = await answer;
      const decision = this.lastDecision ?? none;
      return r.isError ? { decision, error: r.text } : { decision, text: r.text };
    };
    const next = this.tail.then(run, run);
    this.tail = next;
    return next;
  }

  close(): void {
    this.child.kill();
  }
}

const toRaw = (c: CollectedItem, sourceType: SourceType, sourceId: string, grade: string, owner?: string, claim?: string): RawItem => ({
  ...c,
  sourceType,
  sourceId,
  grade,
  ...(c.owner ?? owner ? { owner: (c.owner ?? owner)! } : {}),
  ...(c.claim ?? claim ? { claim: (c.claim ?? claim)! } : {}),
});

export async function runCollector(source: CollectorSource, o: RunOptions = {}): Promise<CollectResult> {
  const spec = TOOL[source.type];
  const call = o.call ?? { tool: spec.tool, args: { [spec.arg]: source.location } };
  const session = new CollectorSession({ trusted: [source.location], name: source.id, ...(o.audit ? { audit: o.audit } : {}), ...(o.command ? { command: o.command } : {}) });
  try {
    const r = await session.call(call.tool, call.args, o.timeoutMs);
    if (r.error !== undefined) return { source, decision: r.decision, items: [], error: r.error };
    let parsed: CollectedItem[];
    try {
      parsed = JSON.parse(r.text ?? '') as CollectedItem[];
    } catch {
      return { source, decision: r.decision, items: [], error: 'collector returned something that is not JSON' };
    }
    return { source, decision: r.decision, items: parsed.map(c => toRaw(c, spec.sourceType, source.id, source.grade, source.owner, source.claim)) };
  } finally {
    session.close();
  }
}

export interface TelegramChannel {
  channel: string;
  grade: string;
}

/** "chan_a:D3, chan_b" -> channels with a grade each (F6 when none is given). */
export function parseTelegramChannels(v: string | undefined): TelegramChannel[] {
  return (v ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const [name, grade] = s.split(':');
    const channel = name!.replace(/^@/, '').trim();
    if (/[\/.\s]/.test(s) || !/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(channel)) throw new Error(`TELEGRAM_CHANNELS: "${s}" is not a public channel username`);
    return { channel, grade: grade ? gradeString(parseGrade(grade.trim())) : 'F6' };
  });
}

export interface StreamerOptions {
  channels: readonly TelegramChannel[];
  ingest: (items: RawItem[]) => Promise<unknown>;
  /** Last message id seen per channel, kept across restarts. */
  cursor: { get(key: string): Promise<string | undefined>; put(key: string, value: string): Promise<void> };
  audit?: AuditLog;
  intervalMs?: number;
  command?: { command: string; args: string[] };
  env?: NodeJS.ProcessEnv;
  onError?: (channel: string, error: string) => void;
}

/**
 * Live Telegram collection. The stream is a poll: every interval, each configured channel is asked for messages
 * newer than its cursor THROUGH the gate proxy, so each request is a gated, audited tool call and each batch of
 * messages is untrusted provenance. The configured channel names are the only trusted text; a channel named in a
 * message can never be polled.
 */
export class TelegramStreamer {
  private session: CollectorSession | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly o: StreamerOptions) {}

  start(): void {
    const tick = () => void this.pollOnce().catch(() => undefined);
    this.timer = setInterval(tick, this.o.intervalMs ?? 15_000);
    this.timer.unref();
    tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.session?.close();
    this.session = undefined;
  }

  /** One pass over every channel. Returns how many messages were handed to ingestion. */
  async pollOnce(only?: string, callOverride?: { tool: string; args: Record<string, unknown> }): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let total = 0;
    try {
      this.session ??= new CollectorSession({
        trusted: this.o.channels.map(c => c.channel), name: 'telegram',
        ...(this.o.audit ? { audit: this.o.audit } : {}), ...(this.o.command ? { command: this.o.command } : {}), ...(this.o.env ? { env: this.o.env } : {}),
      });
      for (const ch of this.o.channels) {
        if (only && ch.channel !== only) continue;
        const key = `telegram:cursor:${ch.channel}`;
        const afterId = Number((await this.o.cursor.get(key)) ?? 0) || 0;
        const call = callOverride ?? { tool: 'telegram_poll', args: { channel: ch.channel, afterId, limit: 100 } };
        const r = await this.session.call(call.tool, call.args);
        if (r.error !== undefined) {
          this.o.onError?.(ch.channel, r.error);
          continue;
        }
        let msgs: CollectedItem[];
        try {
          msgs = JSON.parse(r.text ?? '[]') as CollectedItem[];
        } catch {
          this.o.onError?.(ch.channel, 'collector returned something that is not JSON');
          continue;
        }
        if (!msgs.length) continue;
        await this.o.ingest(msgs.map(m => toRaw(m, 'telegram', ch.channel, ch.grade)));
        total += msgs.length;
        const newest = Math.max(afterId, ...msgs.map(m => Number(m.externalId) || 0));
        await this.o.cursor.put(key, String(newest));
      }
    } finally {
      this.running = false;
    }
    return total;
  }
}
