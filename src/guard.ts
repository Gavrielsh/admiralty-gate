/**
 * The gate: a deterministic reference monitor between an LLM agent and its
 * tools. The model proposes calls; this decides. No model output can change
 * a decision, because decisions depend only on (a) the tool's declared risk
 * tier, (b) where each argument value provably came from, and (c) operator
 * configuration.
 *
 * Decisions:
 *   allow             - run it.
 *   require_approval  - ask a human; run only if approved.
 *   deny              - never run (and the reason goes back to the model as data).
 *
 * The rules are fail-closed for sensitive tiers: an argument that cannot be
 * traced (the model paraphrased, encoded or invented it) is "unknown", and
 * unknown never authorises an action on a person or an active probe.
 */
import { AuditLog } from './audit.js';
import { ProvenanceLedger, type Trace } from './provenance.js';

/** Risk tiers for tools. Operators map each tool name to a tier. */
export type Tier =
  /** Moves a camera, toggles a layer: no external effect, no data about people. */
  | 'view'
  /** Passive lookups on infrastructure: DNS, WHOIS, certificates, BGP, known-CVE databases. */
  | 'lookup-infra'
  /** Lookups that profile a natural person: username hunts, phone, email-breach, personal code accounts. */
  | 'lookup-person'
  /** Active probing of a target host: port/vuln scanning, header or TLS probing through a scanner. */
  | 'active-probe'
  /** Emits something others will rely on: alert, report, dispatch. */
  | 'publish';

export interface ToolSpec {
  tier: Tier;
  /**
   * Argument names whose values are "targets" and therefore traced. Others are ignored.
   * Use '*' to trace every argument: the safe choice when you do not control which argument the tool reads its
   * target from (third-party MCP servers, tools with aliases).
   */
  targetArgs: readonly string[] | '*';
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export type Verdict = 'allow' | 'require_approval' | 'deny';

export interface Decision {
  verdict: Verdict;
  tool: string;
  tier: Tier | 'unregistered';
  reasons: string[];
  traces: Record<string, Trace['class']>;
}

export interface GateConfig {
  /** A tool's spec, or a function that derives it from the call (e.g. a "recon" tool whose sub-tool sets the tier). */
  tools: Record<string, ToolSpec | ((call: ToolCall) => ToolSpec)>;
  /**
   * Hosts/IPs/domains the operator owns or is authorised to probe. Active probes
   * outside this list are denied outright, whatever the provenance.
   */
  authorisedTargets?: readonly string[];
  /** Verdict for a sensitive tier when an argument's origin is "unknown". Default: require_approval. */
  onUnknown?: Verdict;
  /** Verdict when an infra-lookup argument comes only from untrusted text. Default: require_approval. */
  onTaintedInfra?: Verdict;
  /**
   * Verdict when a person-lookup / active-probe / publish argument comes only from untrusted text. Default: deny.
   * Set "require_approval" only where a human really sees the request (e.g. the MCP proxy with elicitation), so an
   * analyst can say "yes, look up the handle from that post".
   */
  onTaintedSensitive?: Verdict;
  /**
   * Verdict for an untraceable argument on a passive infra lookup. Default "allow" (passive public-data lookups are
   * low-harm and models legitimately derive hostnames); set "require_approval" for strict mode.
   */
  onUnknownInfra?: Verdict;
  /** Unregistered tools: default deny. */
  allowUnregistered?: boolean;
  /** Spec applied to tools not listed in `tools` (e.g. `{ tier: 'lookup-person', targetArgs: '*' }` to fail closed but usable). */
  defaultTool?: ToolSpec;
}

const ORDER: Verdict[] = ['allow', 'require_approval', 'deny'];
const worst = (a: Verdict, b: Verdict): Verdict => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);

function hostOf(v: string): string {
  try {
    return new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`).hostname.toLowerCase();
  } catch {
    return v.trim().toLowerCase();
  }
}

const HOSTNAME = /^(?:[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*\.?$/;
const IPV6 = /^\[[0-9a-f:.]+\]$/;

/**
 * Is this value exactly ONE host (name, IP or URL)? Scanners commonly accept "a,b" or "a b" as several targets, so a
 * value like "evil.example lab.example" must never be judged by its suffix alone.
 */
export function isSingleHost(target: string): boolean {
  if (/[\s,;|<>"'`\\]/.test(target.trim()) || !target.trim()) return false;
  const h = hostOf(target);
  return HOSTNAME.test(h) || IPV6.test(h);
}

/** Scalar leaves of an argument value: arrays and objects are walked, so a list of targets is checked item by item. */
export function scalarLeaves(v: unknown, depth = 0): (string | number)[] {
  if (typeof v === 'string') return v ? [v] : [];
  if (typeof v === 'number') return [v];
  if (v === null || typeof v !== 'object' || depth > 6) return [];
  const out: (string | number)[] = [];
  for (const x of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) out.push(...scalarLeaves(x, depth + 1));
  return out;
}

const RANK: Record<Trace['class'], number> = { trusted: 0, tainted: 1, unknown: 2 };

function matchesAuthorised(target: string, authorised: readonly string[]): boolean {
  if (!isSingleHost(target)) return false;
  const h = hostOf(target).replace(/\.$/, '');
  return authorised.some(a => {
    const x = a.toLowerCase();
    return h === x || h.endsWith(`.${x}`);
  });
}

export class Gate {
  constructor(
    private readonly ledger: ProvenanceLedger,
    private readonly cfg: GateConfig,
    private readonly audit: AuditLog = new AuditLog(),
  ) {}

  auditLog(): AuditLog {
    return this.audit;
  }

  decide(call: ToolCall): Decision {
    // Own-property lookup only: a tool named "constructor" or "toString" must not resolve to Object.prototype.
    const entry = Object.hasOwn(this.cfg.tools, call.tool) ? this.cfg.tools[call.tool] : this.cfg.defaultTool;
    const spec = typeof entry === 'function' ? entry(call) : entry;
    const traces: Record<string, Trace['class']> = {};
    const reasons: string[] = [];

    if (!spec) {
      const verdict: Verdict = this.cfg.allowUnregistered ? 'allow' : 'deny';
      const d: Decision = { verdict, tool: call.tool, tier: 'unregistered', reasons: ['tool is not registered with the gate'], traces };
      this.audit.append('decision', d);
      return d;
    }

    const onUnknown = this.cfg.onUnknown ?? 'require_approval';
    const onTaintedInfra = this.cfg.onTaintedInfra ?? 'require_approval';
    let verdict: Verdict = 'allow';

    if (spec.tier === 'view') {
      const d: Decision = { verdict: 'allow', tool: call.tool, tier: spec.tier, reasons: ['view tier has no external effect'], traces };
      this.audit.append('decision', d);
      return d;
    }

    const sensitive = spec.tier !== 'lookup-infra';
    const onTaintedSensitive = this.cfg.onTaintedSensitive ?? 'deny';
    const names = spec.targetArgs === '*' ? Object.keys(call.args) : spec.targetArgs;
    let targets = 0;

    for (const name of names) {
      for (const leaf of scalarLeaves(call.args[name])) {
        targets++;
        const t = this.ledger.trace(leaf);
        // Report the least-trusted class seen for this argument.
        if (traces[name] === undefined || RANK[t.class] > RANK[traces[name]!]) traces[name] = t.class;

        if (spec.tier === 'active-probe' && !matchesAuthorised(String(leaf), this.cfg.authorisedTargets ?? [])) {
          verdict = 'deny';
          reasons.push(
            isSingleHost(String(leaf))
              ? `"${name}" is not in the operator's authorised-target list; active probing is limited to systems the operator owns or is authorised to test`
              : `"${name}" is not a single host; a probe target must be exactly one hostname, IP or URL`,
          );
        }

        if (t.class === 'trusted') continue;

        const via = t.origins.map(o => `${o.kind}:${o.id}`).join(', ');
        if (t.class === 'tainted') {
          if (!sensitive) {
            verdict = worst(verdict, onTaintedInfra);
            reasons.push(`"${name}" appears only in untrusted text (${via}); infra lookups on feed-supplied targets need approval`);
          } else {
            verdict = worst(verdict, onTaintedSensitive);
            reasons.push(`"${name}" appears only in untrusted text (${via}); untrusted data cannot authorise a ${spec.tier} action`);
          }
        } else if (!sensitive) {
          // unknown: the model produced a value no recorded span contains.
          const v = this.cfg.onUnknownInfra ?? 'allow';
          verdict = worst(verdict, v);
          if (v !== 'allow') reasons.push(`"${name}" cannot be traced to the operator or to any recorded source; strict infra mode`);
        } else {
          verdict = worst(verdict, onUnknown);
          reasons.push(`"${name}" cannot be traced to the operator or to any recorded source (paraphrased, encoded or invented)`);
        }
      }
    }

    // A person lookup or probe with no recognisable target must not pass as "everything traced": the tool may be
    // reading its target from an argument the gate was not told about.
    if (targets === 0 && (spec.tier === 'lookup-person' || spec.tier === 'active-probe')) {
      verdict = worst(verdict, onUnknown);
      reasons.push(`no target argument found for a ${spec.tier} call; nothing to trace, so it cannot be authorised automatically`);
    }

    if (spec.tier === 'publish') {
      // Publishing is released through canRelease() on the assessment, not through argument tracing.
      verdict = worst(verdict, 'require_approval');
      reasons.push('publish tier always needs an explicit release decision');
    }

    if (reasons.length === 0) reasons.push(targets ? 'all target arguments trace to the operator' : 'no target arguments');
    const d: Decision = { verdict, tool: call.tool, tier: spec.tier, reasons, traces };
    this.audit.append('decision', d);
    return d;
  }
}

export type Exec<R> = (call: ToolCall) => Promise<R>;

export interface Guarded<R> {
  /** Run `call` through the gate; `approve` is consulted only for require_approval. */
  run(call: ToolCall, exec: Exec<R>, approve?: (d: Decision) => Promise<boolean>): Promise<{ decision: Decision; executed: boolean; result?: R }>;
}

export function guarded<R>(gate: Gate): Guarded<R> {
  return {
    async run(call, exec, approve) {
      const decision = gate.decide(call);
      if (decision.verdict === 'deny') return { decision, executed: false };
      if (decision.verdict === 'require_approval') {
        const ok = approve ? await approve(decision) : false;
        gate.auditLog().append('approval', { tool: call.tool, approved: ok });
        if (!ok) return { decision, executed: false };
      }
      const result = await exec(call);
      return { decision, executed: true, result };
    },
  };
}
