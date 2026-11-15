/**
 * Fastify API around admiralty-gate: live event stream, human approvals, sandbox runner, policy, audit, grounding.
 *
 * This is a local operator console. It binds to 127.0.0.1, only accepts browser requests from the configured web
 * origin, and has no authentication: do not expose it on a network.
 */
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AuditLog, GuardedSession, McpGateProxy, ProvenanceLedger, groundReport, parseGrade, parsePolicy, summariseGrounding,
  type AuditRecord, type Decision, type OriginKind, type Policy, type RpcMessage, type ToolCall,
} from 'admiralty-gate';
import { ApprovalQueue } from './approvals.js';
import { EventBus, type GateEvent } from './bus.js';
import { CallTracker, type CallRecord } from './calls.js';
import { hashEmbedding } from './fusion/embed.js';
import { GeoIpTable } from './fusion/geoip.js';
import { BullQueue, InlineQueue, type JobQueue } from './fusion/queue.js';
import { registerFusionRoutes } from './fusion/routes.js';
import { FusionService } from './fusion/service.js';
import { MemoryStore } from './fusion/store.js';
import type { Store } from './fusion/types.js';
import { newAnthropicClient, runAnthropicAgent, runOpenAiAgent, type AnthropicLike } from './sandbox/agents.js';
import { SCENARIOS, type Scenario } from './sandbox/scenarios.js';
import { DEFAULT_FEED, DEFAULT_POLICY, TOOL_DEFS, simulatedTool } from './sandbox/tools.js';

export interface AppOptions {
  /** Holds policy.json and audit.jsonl. */
  dataDir: string;
  env?: Record<string, string | undefined>;
  webOrigins?: readonly string[];
  approvalTimeoutMs?: number;
  /** Pause between scripted steps so the browser shows them arriving. 0 in tests. */
  stepDelayMs?: number;
  fetch?: typeof fetch;
  anthropicClient?: (apiKey: string) => AnthropicLike;
  logger?: boolean;
  /** Where provenance, incidents and the audit mirror live. Default: in memory. */
  store?: Store;
  /** Redis URL for BullMQ queues. Default: in-process queue. */
  redisUrl?: string;
  /** BullMQ key prefix (lets test runs share a Redis). */
  queuePrefix?: string;
  /** Text embedding of dimension 256. Default: lexical hashing (see fusion/embed.ts). */
  embed?: (text: string) => number[];
  /** How often policy.json is checked for edits made outside the API. Default 1000 ms; 0 disables. */
  policyWatchMs?: number;
}

export interface App {
  fastify: FastifyInstance;
  bus: EventBus;
  approvals: ApprovalQueue;
  fusion: FusionService;
  store: Store;
  queue: JobQueue;
  /** Re-read policy.json now (the file watcher calls this). */
  reloadPolicy: () => void;
  /** Resolves when a sandbox run has finished (tests). */
  runFinished: (runId: string) => Promise<RunInfo>;
}

export interface RunInfo {
  id: string;
  mode: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  finishedAt?: number;
  calls: string[];
  error?: string;
  outcome?: string;
}

const KINDS: readonly OriginKind[] = ['feed', 'web', 'telegram', 'sensor', 'tool', 'model', 'file'];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sleep = (ms: number) => (ms > 0 ? new Promise<void>(r => setTimeout(r, ms)) : Promise.resolve());

/** Verify a JSONL audit file line by line: a line that is not JSON breaks the chain at that line. */
export function verifyAuditFile(text: string): { entries: unknown[]; chainValid: boolean; brokenAt?: number; reason?: string; head: string | null } {
  const lines = text.split('\n').filter(l => l.trim());
  const entries: unknown[] = [];
  const records: AuditRecord[] = [];
  let bad: { at: number; reason: string } | undefined;
  lines.forEach((line, i) => {
    try {
      const r = JSON.parse(line) as AuditRecord;
      entries.push(r);
      if (!bad) records.push(r);
    } catch {
      entries.push({ seq: i, unparseable: line.slice(0, 200) });
      bad ??= { at: i, reason: 'line is not valid JSON' };
    }
  });
  const v = AuditLog.verify(records);
  if (!v.ok) bad = { at: v.at, reason: v.reason };
  const last = records[records.length - 1];
  return { entries, chainValid: !bad, ...(bad ? { brokenAt: bad.at, reason: bad.reason } : {}), head: !bad && last ? last.hash : null };
}

export async function buildApp(o: AppOptions): Promise<App> {
  const env = o.env ?? process.env;
  const origins = o.webOrigins ?? ['http://localhost:3000', 'http://127.0.0.1:3000'];
  const stepDelay = o.stepDelayMs ?? 450;
  mkdirSync(o.dataDir, { recursive: true });
  const policyFile = join(o.dataDir, 'policy.json');
  const auditFile = join(o.dataDir, 'audit.jsonl');

  const bus = new EventBus();
  const boot = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const tracker = new CallTracker(bus);
  const approvals = new ApprovalQueue(bus, o.approvalTimeoutMs);

  // ---- policy: strict, fail closed. An invalid file on disk stops the server rather than running with a guess.
  if (!existsSync(policyFile)) writeFileSync(policyFile, JSON.stringify(DEFAULT_POLICY, null, 2) + '\n');
  let policyRaw: unknown = JSON.parse(readFileSync(policyFile, 'utf8'));
  let policy: Policy = parsePolicy(policyRaw);

  const store = o.store ?? new MemoryStore();
  await store.init();

  // ---- audit: one hash chain for the whole server. A file that no longer verifies is set aside, never extended.
  let quarantined: { file: string; brokenAt: number; reason: string } | undefined;
  if (existsSync(auditFile)) {
    const v = verifyAuditFile(readFileSync(auditFile, 'utf8'));
    if (!v.chainValid) {
      const moved = `${auditFile}.broken-${Date.now()}`;
      renameSync(auditFile, moved);
      quarantined = { file: moved, brokenAt: v.brokenAt!, reason: v.reason! };
    }
  }
  const prior = existsSync(auditFile) ? AuditLog.fromJsonl(readFileSync(auditFile, 'utf8')) : [];
  const audit = new AuditLog(
    () => Date.now(),
    rec => {
      // The file is the authority; the database row is a queryable copy and may lag by one write.
      appendFileSync(auditFile, JSON.stringify(rec) + '\n');
      mirrorWrites = mirrorWrites.then(() => store.mirrorAudit({ seq: rec.seq, hash: rec.hash, prev: rec.prev, kind: rec.kind, at: rec.at, data: rec.data })).catch(() => undefined);
      bus.emit('audit.appended', { record: rec });
    },
    prior,
  );
  let mirrorWrites: Promise<void> = Promise.resolve();
  // Bring the mirror in line with the file: after a quarantine, a restore, or a first run against an existing log.
  const m0 = await store.auditMirror();
  if (m0.count !== prior.length || m0.head !== (prior[prior.length - 1]?.hash ?? null)) {
    await store.truncateAuditMirror(0);
    for (const r of prior) await store.mirrorAudit({ seq: r.seq, hash: r.hash, prev: r.prev, kind: r.kind, at: r.at, data: r.data });
  }
  if (quarantined) audit.append('audit.quarantined', quarantined);

  // ---- fusion: one workspace ledger for everything ingested, always untrusted and graded.
  const fusionLedger = new ProvenanceLedger();
  const geoip = GeoIpTable.fromFile(env.GEOIP_CSV);
  const embed = o.embed ?? hashEmbedding;
  const fusion = new FusionService({ store, bus, ledger: fusionLedger, geoip, embed });
  const onJobError = (name: string, e: Error) => bus.emit('fusion.job_failed', { queue: name, error: e.message.slice(0, 300) });
  const queue: JobQueue = o.redisUrl ? new BullQueue(o.redisUrl, fusion.handlers, o.queuePrefix, onJobError) : new InlineQueue(fusion.handlers, onJobError);
  fusion.attach(queue);
  await fusion.rebuildLedger();

  const fastify = Fastify({ logger: o.logger ?? false });
  await fastify.register(cors, { origin: [...origins], methods: ['GET', 'POST', 'PUT'] });
  // A page on another site must not be able to approve a tool call or edit the policy through the user's browser.
  fastify.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (req.method !== 'GET' && req.method !== 'OPTIONS' && origin && !origins.includes(origin))
      return reply.code(403).send({ error: `origin ${origin} is not allowed to change state` });
  });
  fastify.addHook('onClose', async () => {
    approvals.denyAll();
    if (watching) unwatchFile(policyFile);
    await queue.close();
    await mirrorWrites;
    await store.close();
  });

  const providers = () => ({
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    openai: Boolean(env.OPENAI_API_KEY),
    anthropicModel: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
    openaiModel: env.OPENAI_MODEL || 'gpt-4o',
  });

  fastify.get('/api/health', async () => ({ ok: true, providers: providers(), pendingApprovals: approvals.list().length }));

  // ---- live events (SSE). Reconnects resume from Last-Event-ID; first connects get the backlog.
  fastify.get('/events', (req, reply) => {
    const q = req.query as { since?: string };
    const last = Number(req.headers['last-event-id'] ?? q.since ?? 0) || 0;
    reply.hijack();
    const res = reply.raw;
    const origin = req.headers.origin;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...(origin && origins.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
    });
    const send = (e: GateEvent) => res.write(`id: ${e.seq}\nevent: gate\ndata: ${JSON.stringify(e)}\n\n`);
    // `boot` changes when the server restarts, so a browser knows its event numbering is stale.
    res.write(`retry: 1500\nevent: hello\ndata: ${JSON.stringify({ boot })}\n\n`);
    for (const e of bus.since(last)) send(e);
    const off = bus.subscribe(send);
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    req.raw.on('close', () => {
      off();
      clearInterval(beat);
    });
  });
  fastify.get('/api/events', async req => ({ events: bus.since(Number((req.query as { since?: string }).since ?? 0) || 0) }));

  // ---- approvals
  fastify.get('/api/approvals', async () => ({ pending: approvals.list() }));
  fastify.post('/api/approvals/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body;
    if (!isObj(body) || typeof body.approve !== 'boolean')
      return reply.code(400).send({ error: 'body must be {"approve": true} or {"approve": false}' });
    if (!approvals.resolve(id, body.approve))
      return reply.code(404).send({ error: `no pending approval "${id}" (unknown, already answered, or timed out)` });
    return { id, state: body.approve ? 'approved' : 'denied' };
  });

  // ---- policy
  fastify.get('/api/policy', async () => ({ policy: policyRaw, file: policyFile }));
  fastify.post('/api/policy/validate', async req => {
    try {
      parsePolicy(req.body);
      return { valid: true };
    } catch (e) {
      return { valid: false, error: (e as Error).message };
    }
  });
  fastify.put('/api/policy', async (req, reply) => {
    let next: Policy;
    try {
      next = parsePolicy(req.body);
    } catch (e) {
      return reply.code(400).send({ valid: false, error: (e as Error).message });
    }
    writeFileSync(policyFile, JSON.stringify(req.body, null, 2) + '\n');
    policyRaw = req.body;
    policy = next;
    audit.append('policy.updated', { tools: Object.keys(next.config.tools), authorisedTargets: next.config.authorisedTargets ?? [] });
    bus.emit('policy.updated', { policy: policyRaw });
    return { valid: true, policy: policyRaw };
  });

  // Hot reload: an edit made to policy.json outside the API takes effect without a restart, if and only if it
  // passes the strict validator. A bad edit is reported and the running policy stays as it was.
  const reloadPolicy = () => {
    let text: string;
    try {
      text = readFileSync(policyFile, 'utf8');
    } catch {
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
      if (JSON.stringify(raw) === JSON.stringify(policyRaw)) return;
      policy = parsePolicy(raw);
    } catch (e) {
      bus.emit('policy.rejected', { error: (e as Error).message, source: 'file' });
      return;
    }
    policyRaw = raw;
    audit.append('policy.updated', { source: 'file', tools: Object.keys(policy.config.tools), authorisedTargets: policy.config.authorisedTargets ?? [] });
    bus.emit('policy.updated', { policy: policyRaw, source: 'file' });
  };
  const watchMs = o.policyWatchMs ?? 1000;
  const watching = watchMs > 0;
  if (watching) watchFile(policyFile, { interval: watchMs }, reloadPolicy);

  // ---- audit
  const readAudit = () => verifyAuditFile(existsSync(auditFile) ? readFileSync(auditFile, 'utf8') : '');
  fastify.get('/api/audit', async () => {
    await mirrorWrites;
    const m = await store.auditMirror();
    return { ...readAudit(), file: auditFile, mirror: { store: store.kind, count: m.count, head: m.head, inSync: m.count === audit.records().length && m.head === (audit.records().length ? audit.head() : null) }, ...(quarantined ? { quarantined } : {}) };
  });
  /**
   * Demo only: edits one record IN THE FILE (never the in-memory chain) so the viewer can show detection.
   * `restore` rewrites the file from memory. Disable with ADMIRALTY_TAMPER_DEMO=0.
   */
  const tamperEnabled = env.ADMIRALTY_TAMPER_DEMO !== '0';
  fastify.post('/api/audit/tamper', async (req, reply) => {
    if (!tamperEnabled) return reply.code(403).send({ error: 'tamper demo is disabled (ADMIRALTY_TAMPER_DEMO=0)' });
    const lines = (existsSync(auditFile) ? readFileSync(auditFile, 'utf8') : '').split('\n').filter(l => l.trim());
    if (!lines.length) return reply.code(409).send({ error: 'the audit log is empty; run a sandbox scenario first' });
    const want = isObj(req.body) && Number.isInteger(req.body.index) ? (req.body.index as number) : -1;
    const records = lines.map(l => JSON.parse(l) as AuditRecord);
    const lastDeny = records.map(r => (isObj(r.data) ? r.data.verdict : null)).lastIndexOf('deny');
    const pick = want >= 0 && want < records.length ? want : lastDeny >= 0 ? lastDeny : Math.max(0, records.map(r => r.kind).lastIndexOf('decision'));
    const rec = records[pick]!;
    const data: Record<string, unknown> = isObj(rec.data) ? { ...rec.data } : { value: rec.data };
    // The classic edit an attacker wants: turn a refusal into an approval after the fact.
    if (data.verdict === 'deny' || data.verdict === 'require_approval') data.verdict = 'allow';
    else data.tampered = true;
    lines[pick] = JSON.stringify({ ...rec, data });
    writeFileSync(auditFile, lines.join('\n') + '\n');
    bus.emit('audit.tampered', { index: pick });
    return { index: pick, ...readAudit() };
  });
  fastify.post('/api/audit/restore', async () => {
    writeFileSync(auditFile, audit.toJsonl());
    bus.emit('audit.restored', {});
    return readAudit();
  });

  // ---- grounding
  fastify.post('/api/grounding', async (req, reply) => {
    const b = req.body;
    if (!isObj(b) || typeof b.report !== 'string' || !Array.isArray(b.sources))
      return reply.code(400).send({ error: 'body must be {"report": string, "sources": [{"text": string, "id"?, "kind"?, "grade"?, "owner"?, "trusted"?}]}' });
    const ledger = new ProvenanceLedger();
    const sources: { spanId: string; id: string; kind: string; grade?: string; trusted: boolean; text: string }[] = [];
    for (const [i, s] of b.sources.entries()) {
      if (!isObj(s) || typeof s.text !== 'string') return reply.code(400).send({ error: `sources[${i}].text must be a string` });
      if (!s.text.trim()) continue;
      const id = typeof s.id === 'string' && s.id.trim() ? s.id.trim() : `source-${i + 1}`;
      if (s.trusted === true) {
        sources.push({ spanId: ledger.addTrusted(s.text).id, id: 'operator', kind: 'user', trusted: true, text: s.text });
        continue;
      }
      const kind = KINDS.includes(s.kind as OriginKind) ? (s.kind as OriginKind) : 'web';
      let grade;
      if (typeof s.grade === 'string' && s.grade.trim()) {
        try {
          grade = parseGrade(s.grade);
        } catch (e) {
          return reply.code(400).send({ error: `sources[${i}].grade: ${(e as Error).message}` });
        }
      }
      const span = ledger.addUntrusted(s.text, { id, kind, ...(grade ? { grade } : {}), ...(typeof s.owner === 'string' && s.owner ? { owner: s.owner } : {}) });
      sources.push({ spanId: span.id, id, kind, trusted: false, text: s.text, ...(grade ? { grade: s.grade as string } : {}) });
    }
    // "useLedger": also check the report against everything ingested into the fusion workspace.
    if (b.useLedger === true)
      for (const s of fusionLedger.spans()) {
        const span = ledger.addUntrusted(s.text, s.origin);
        sources.push({ spanId: span.id, id: s.origin.id, kind: s.origin.kind, trusted: false, text: s.text, ...(s.origin.grade ? { grade: `${s.origin.grade.r}${s.origin.grade.c}` } : {}) });
      }
    const gs = groundReport(b.report, ledger);
    return {
      sentences: gs.map(g => ({
        ...g,
        // What the inspector colours by: corroborated by 2+ independent origins, one origin only, partial, or none.
        level: g.status === 'operator' ? 'operator' : g.status === 'grounded' ? (g.independentOrigins >= 2 ? 'verified' : 'single') : g.status,
      })),
      summary: summariseGrounding(gs),
      sources,
    };
  });

  // ---- sandbox
  const runs = new Map<string, RunInfo>();
  const done = new Map<string, Promise<RunInfo>>();
  let runSeq = 0;

  /** One gated session: GuardedSession wired to the tracker, the approval queue and the shared audit chain. */
  function gatedSession(run: RunInfo, feed: string) {
    let current: CallRecord | undefined;
    const p = policy;
    const session = new GuardedSession(p.config, {
      audit,
      onDecision: d => current && tracker.decided(current, d, p.config.authorisedTargets ?? [], session.ledger),
      approve: async () => (current ? approvals.request(current) : false),
    });
    for (const t of p.trusted) session.operatorSays(t);
    const exec = simulatedTool(feed);
    return {
      session,
      async call(call: ToolCall): Promise<{ text: string; blocked: boolean; rec: CallRecord }> {
        const rec = (current = tracker.intercept(run.id, 'sandbox', call));
        run.calls.push(rec.id);
        const r = await session.call(call, exec);
        tracker.finish(rec, r.executed, r.executed ? r.result : r.message);
        return { text: r.executed ? r.result : r.message, blocked: !r.executed, rec };
      },
    };
  }

  const say = (run: RunInfo, role: 'operator' | 'model' | 'note', text: string) => bus.emit('session.message', { sessionId: run.id, role, text });

  async function runScripted(run: RunInfo, sc: Pick<Scenario, 'operator' | 'feed' | 'call'>): Promise<string> {
    const g = gatedSession(run, sc.feed);
    if (sc.operator) {
      g.session.operatorSays(sc.operator);
      say(run, 'operator', sc.operator);
    }
    await sleep(stepDelay);
    if (sc.feed) {
      say(run, 'model', 'Reading the news feed.');
      await g.call({ tool: 'search_news', args: { query: 'latest' } });
      await sleep(stepDelay);
      say(run, 'model', `(scripted model, obeys whatever it reads) Calling ${sc.call.tool}.`);
    } else say(run, 'model', `Calling ${sc.call.tool} as the operator asked.`);
    const r = await g.call(sc.call);
    return r.rec.gate ?? 'UNKNOWN';
  }

  /** The same policy enforced by the MCP proxy, against an in-process stand-in for an MCP server. */
  async function runMcpDemo(run: RunInfo, sc: Pick<Scenario, 'feed' | 'call'>): Promise<string> {
    const p = policy;
    const byRpcId = new Map<number, CallRecord>();
    let rpc = 0;
    let lastRec: CallRecord | undefined;
    const settled: Promise<void>[] = [];
    const waiters = new Map<number, () => void>();
    const proxy: McpGateProxy = new McpGateProxy({
      config: p.config, trusted: p.trusted, audit, serverName: 'demo-mcp',
      toServer: msg => {
        // Stand-in MCP server: lists tools (with the scenario text as a description) and "runs" calls.
        if (msg.method === 'tools/list')
          proxy.onServerMessage({ jsonrpc: '2.0', id: msg.id!, result: { tools: TOOL_DEFS.map(t => ({ name: t.name, description: t.name === 'search_news' ? `${t.description} ${sc.feed}` : t.description })) } });
        else if (msg.method === 'tools/call') {
          const rec = byRpcId.get(msg.id as number);
          if (rec) tracker.finish(rec, true, '[simulated MCP server] call executed');
          proxy.onServerMessage({ jsonrpc: '2.0', id: msg.id!, result: { content: [{ type: 'text', text: '[simulated] ok' }] } });
          waiters.get(msg.id as number)?.();
        } else if (msg.id !== undefined && msg.id !== null) proxy.onServerMessage({ jsonrpc: '2.0', id: msg.id, result: {} });
      },
      toClient: (msg: RpcMessage) => {
        const rec = typeof msg.id === 'number' ? byRpcId.get(msg.id) : undefined;
        if (rec && isObj(msg.result) && msg.result.isError === true) {
          tracker.finish(rec, false, JSON.stringify(msg.result.content));
          waiters.get(msg.id as number)?.();
        }
      },
      onDecision: (d: Decision) => lastRec && tracker.decided(lastRec, d, p.config.authorisedTargets ?? [], proxy.ledger),
      approve: async () => (lastRec ? approvals.request(lastRec) : false),
    });
    const callTool = (call: ToolCall) => {
      const id = ++rpc;
      lastRec = tracker.intercept(run.id, 'mcp-proxy', call);
      byRpcId.set(id, lastRec);
      run.calls.push(lastRec.id);
      settled.push(new Promise<void>(r => waiters.set(id, r)));
      proxy.onClientMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: call.tool, arguments: call.args } });
      return lastRec;
    };
    say(run, 'note', 'MCP client connects through the proxy and lists the server\'s tools.');
    proxy.onClientMessage({ jsonrpc: '2.0', id: ++rpc, method: 'initialize', params: { capabilities: {} } });
    proxy.onClientMessage({ jsonrpc: '2.0', id: ++rpc, method: 'tools/list' });
    await sleep(stepDelay);
    say(run, 'model', `(scripted model) The tool description says to call ${sc.call.tool}. Calling it.`);
    const rec = callTool(sc.call);
    await Promise.all(settled);
    return rec.gate ?? 'UNKNOWN';
  }

  async function runLive(run: RunInfo, mode: 'anthropic' | 'openai', prompt: string, feed: string): Promise<string> {
    const g = gatedSession(run, feed);
    g.session.operatorSays(prompt);
    say(run, 'operator', prompt);
    const hooks = { callTool: (c: ToolCall) => g.call(c), say: (t: string) => say(run, 'model', t) };
    const pv = providers();
    if (mode === 'anthropic') return runAnthropicAgent((o.anthropicClient ?? newAnthropicClient)(env.ANTHROPIC_API_KEY!), pv.anthropicModel, prompt, hooks);
    return runOpenAiAgent(o.fetch ?? fetch, env.OPENAI_API_KEY!, pv.openaiModel, prompt, hooks, env.OPENAI_BASE_URL || undefined);
  }

  fastify.get('/api/sandbox/scenarios', async () => ({ scenarios: SCENARIOS, providers: providers(), tools: TOOL_DEFS.map(t => t.name), defaultFeed: DEFAULT_FEED }));
  fastify.get('/api/sandbox/runs/:id', async (req, reply) => runs.get((req.params as { id: string }).id) ?? reply.code(404).send({ error: 'no such run' }));

  fastify.post('/api/sandbox/run', async (req, reply) => {
    const b = isObj(req.body) ? req.body : {};
    const mode = b.mode ?? 'simulated';
    const bad = (error: string) => reply.code(400).send({ error });
    let job: (run: RunInfo) => Promise<string>;

    if (mode === 'simulated') {
      if (b.scenarioId !== undefined) {
        const sc = SCENARIOS.find(s => s.id === b.scenarioId);
        if (!sc) return bad(`unknown scenarioId "${String(b.scenarioId)}"`);
        job = run => (sc.kind === 'mcp' ? runMcpDemo(run, sc) : runScripted(run, sc));
      } else {
        const c = b.custom;
        if (!isObj(c) || !isObj(c.call) || typeof c.call.tool !== 'string' || !c.call.tool)
          return bad('simulated mode needs "scenarioId" or "custom": {"operator": string, "feed": string, "call": {"tool": string, "args": object}}');
        if (c.call.args !== undefined && !isObj(c.call.args)) return bad('custom.call.args must be a JSON object');
        const custom = {
          operator: typeof c.operator === 'string' ? c.operator : '', feed: typeof c.feed === 'string' ? c.feed : '',
          call: { tool: c.call.tool, args: (c.call.args as Record<string, unknown> | undefined) ?? {} },
        };
        job = run => runScripted(run, custom);
      }
    } else if (mode === 'anthropic' || mode === 'openai') {
      if (!providers()[mode]) return bad(`${mode === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} is not set in .env.local; use simulated mode or add the key and restart`);
      if (typeof b.prompt !== 'string' || !b.prompt.trim()) return bad('"prompt" (what the operator asks the agent) is required');
      const prompt = b.prompt;
      const feed = typeof b.feed === 'string' ? b.feed : '';
      job = run => runLive(run, mode, prompt, feed);
    } else return bad('mode must be "simulated", "anthropic" or "openai"');

    const run: RunInfo = { id: `run_${++runSeq}`, mode: String(mode), status: 'running', startedAt: Date.now(), calls: [] };
    runs.set(run.id, run);
    bus.emit('session.started', { sessionId: run.id, mode: run.mode, scenarioId: b.scenarioId ?? null });
    done.set(
      run.id,
      job(run)
        .then(outcome => {
          run.status = 'done';
          run.outcome = outcome;
        })
        .catch((e: Error) => {
          run.status = 'error';
          // Provider errors can echo request details; the key itself is never in the message we build.
          run.error = e.message.slice(0, 500);
        })
        .then(() => {
          run.finishedAt = Date.now();
          bus.emit('session.finished', { sessionId: run.id, status: run.status, outcome: run.outcome ?? null, error: run.error ?? null });
          return run;
        }),
    );
    return reply.code(202).send({ runId: run.id });
  });

  // ---- decisions reported by a separate `admiralty-gate-mcp-bridge` process running a real MCP server
  fastify.post('/api/mcp/calls', async (req, reply) => {
    const b = req.body;
    const d = isObj(b) ? b.decision : undefined;
    const c = isObj(b) ? b.call : undefined;
    if (!isObj(b) || !isObj(d) || !isObj(c) || typeof c.tool !== 'string' || !isObj(c.args) ||
        !['allow', 'deny', 'require_approval'].includes(d.verdict as string) || !Array.isArray(d.reasons) || !isObj(d.traces))
      return reply.code(400).send({ error: 'body must be {"server"?: string, "call": {"tool", "args"}, "decision": {"verdict", "tier", "reasons", "traces"}}' });
    const decision = d as unknown as Decision;
    const session = `mcp:${typeof b.server === 'string' ? b.server.slice(0, 80) : 'server'}`;
    const rec = tracker.intercept(session, 'mcp-bridge', { tool: c.tool, args: c.args });
    tracker.decided(rec, decision, policy.config.authorisedTargets ?? []);
    audit.append('decision', { ...decision, source: session });
    let approved = decision.verdict === 'allow';
    if (decision.verdict === 'require_approval') {
      approved = await approvals.request(rec);
      audit.append('approval', { tool: c.tool, approved, source: session });
    }
    tracker.finish(rec, approved, approved ? 'forwarded to the MCP server' : 'not forwarded');
    return { approved, callId: rec.id };
  });

  registerFusionRoutes(fastify, { fusion, store, audit, geoip, env, collectorsFile: join(o.dataDir, 'collectors.json'), embed, queueKind: queue.kind });

  return { fastify, bus, approvals, fusion, store, queue, reloadPolicy, runFinished: id => done.get(id) ?? Promise.reject(new Error('no such run')) };
}
