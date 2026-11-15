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
  /** Argument names whose values are "targets" and therefore traced. Others are ignored. */
  targetArgs: readonly string[];
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
  /** Verdict when an argument comes only from untrusted text. Default: deny for person/probe, approval for infra. */
  onTaintedInfra?: Verdict;
  /**
   * Verdict for an untraceable argument on a passive infra lookup. Default "allow" (passive public-data lookups are
   * low-harm and models legitimately derive hostnames); set "require_approval" for strict mode.
   */
  onUnknownInfra?: Verdict;
  /** Unregistered tools: default deny. */
  allowUnregistered?: boolean;
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

function matchesAuthorised(target: string, authorised: readonly string[]): boolean {
  const h = hostOf(target);
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
    const entry = this.cfg.tools[call.tool];
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

    for (const name of spec.targetArgs) {
      const raw = call.args[name];
      if (raw === undefined || raw === null || raw === '') continue;
      const t = this.ledger.trace(raw);
      traces[name] = t.class;

      if (t.class === 'trusted') continue;

      const via = t.origins.map(o => `${o.kind}:${o.id}`).join(', ');
      if (t.class === 'tainted') {
        if (spec.tier === 'lookup-infra') {
          verdict = worst(verdict, onTaintedInfra);
          reasons.push(`"${name}" appears only in untrusted text (${via}); infra lookups on feed-supplied targets need approval`);
        } else {
          verdict = worst(verdict, 'deny');
          reasons.push(`"${name}" appears only in untrusted text (${via}); untrusted data cannot authorise a ${spec.tier} action`);
        }
      } else {
        // unknown: the model produced a value no recorded span contains.
        if (spec.tier === 'lookup-infra') {
          const v = this.cfg.onUnknownInfra ?? 'allow';
          verdict = worst(verdict, v);
          if (v !== 'allow') reasons.push(`"${name}" cannot be traced to the operator or to any recorded source; strict infra mode`);
        } else {
          verdict = worst(verdict, onUnknown);
          reasons.push(`"${name}" cannot be traced to the operator or to any recorded source (paraphrased, encoded or invented)`);
        }
      }
    }

    if (spec.tier === 'active-probe') {
      for (const name of spec.targetArgs) {
        const raw = call.args[name];
        if (typeof raw !== 'string' || !raw) continue;
        if (!matchesAuthorised(raw, this.cfg.authorisedTargets ?? [])) {
          verdict = 'deny';
          reasons.push(`"${name}" is not in the operator's authorised-target list; active probing is limited to systems the operator owns or is authorised to test`);
        }
      }
    }

    if (spec.tier === 'publish') {
      // Publishing is released through canRelease() on the assessment, not through argument tracing.
      verdict = worst(verdict, 'require_approval');
      reasons.push('publish tier always needs an explicit release decision');
    }

    if (reasons.length === 0) reasons.push('all target arguments trace to the operator');
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
