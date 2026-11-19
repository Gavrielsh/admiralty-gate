/**
 * Adapter for the OSIRIS OI Assist loop (https://github.com/simplifaisoul/osiris, MIT).
 *
 * OSIRIS lets a model call tools (including a `recon` tool that runs username
 * hunts, phone lookups, email-breach lookups and scanner-backed probes) while
 * the same model reads live feed text (news headlines, Telegram posts) in its
 * context. The loop in src/lib/oi/assist/agent.ts has no deterministic check
 * between the two. This adapter supplies one without modifying that loop:
 * wrap `deps.exec` with `gateOsirisExec`.
 */
import { AuditLog } from '../audit.js';
import { extractCoordinates } from '../geo.js';
import type { Grade } from '../grades.js';
import { Gate, isSingleHost, scalarLeaves, type Decision, type GateConfig, type ToolCall, type ToolSpec } from '../guard.js';
import type { ProvenanceLedger } from '../provenance.js';

/** Mirror of the alias table in OSIRIS src/lib/oi/assist/recon.ts, so aliases cannot dodge the tiering. */
const RECON_TOOLS = [
  'self_track', 'shodan', 'dns', 'whois', 'certs', 'ssl', 'subdomains', 'headers',
  'tech', 'bgp', 'mac', 'phone', 'username', 'github', 'threats', 'leaks', 'crypto', 'vuln',
] as const;
type ReconTool = (typeof RECON_TOOLS)[number];

const ALIAS: Record<string, ReconTool> = {
  self: 'self_track', selftrack: 'self_track', me: 'self_track', locate: 'self_track', my_location: 'self_track', track: 'self_track',
  scanner: 'shodan', port_scan: 'shodan', portscan: 'shodan', ports: 'shodan', sweep: 'shodan', iot: 'shodan', device: 'shodan',
  domain: 'dns', breach: 'leaks', breaches: 'leaks', email: 'leaks', wallet: 'crypto', address: 'crypto', chain: 'crypto',
  user: 'username', handle: 'username', reputation: 'threats', threat: 'threats', asn: 'bgp', cert: 'certs', certificates: 'certs',
};

export function reconToolId(v: unknown): ReconTool | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if ((RECON_TOOLS as readonly string[]).includes(s)) return s as ReconTool;
  return ALIAS[s] ?? null;
}

const TARGET_ARGS = ['target', 'query', 'ip', 'domain', 'address', 'number', 'user', 'email', 'host'] as const;

const INFRA = new Set<ReconTool>(['shodan', 'dns', 'whois', 'certs', 'bgp', 'mac', 'threats', 'crypto']);
const PERSON = new Set<ReconTool>(['username', 'phone', 'github', 'leaks']);

function reconSpec(call: ToolCall): ToolSpec {
  const id = reconToolId(call.args.tool ?? call.args.name ?? call.args.type);
  if (id === 'self_track') return { tier: 'view', targetArgs: [] };
  if (id && INFRA.has(id)) return { tier: 'lookup-infra', targetArgs: TARGET_ARGS };
  if (id && PERSON.has(id)) return { tier: 'lookup-person', targetArgs: TARGET_ARGS };
  // vuln / ssl / subdomains / headers / tech go to the scanner backend (active), and any unknown name is
  // treated the same way: fail closed.
  return { tier: 'active-probe', targetArgs: TARGET_ARGS };
}

/**
 * `geo-enrich` on a host, IP or coordinate pair is a passive infrastructure lookup. On anything else (a handle, a
 * phone number, a name) it is locating a person, and is tiered accordingly. No target at all: fail closed.
 */
function geoEnrichSpec(call: ToolCall): ToolSpec {
  const leaves = Object.values(call.args).flatMap(v => scalarLeaves(v)).map(String);
  // A bare word ("carol_k_1988") is a valid single-label hostname, so "is a host" must mean an IP or a dotted name.
  const hostLike = (v: string): boolean => isSingleHost(v) && /[.:]/.test(v);
  const infra = leaves.length > 0 && leaves.every(v => hostLike(v) || extractCoordinates(v).length > 0 || /^-?\d+(\.\d+)?$/.test(v));
  return { tier: infra ? 'lookup-infra' : 'lookup-person', targetArgs: '*' };
}

/** Collection and fusion tools. Hyphen and underscore spellings are both registered so neither dodges the tiering. */
function fusionTools(): GateConfig['tools'] {
  const fetch: ToolSpec = { tier: 'lookup-infra', targetArgs: ['url', 'source', 'channel', 'feed', 'query', 'target'] };
  // An entity graph around a target is a profile of whoever the target is: person tier, every argument traced.
  const graph: ToolSpec = { tier: 'lookup-person', targetArgs: '*' };
  return {
    'osint-fetch': fetch, osint_fetch: fetch,
    'geo-enrich': geoEnrichSpec, geo_enrich: geoEnrichSpec,
    'entity-graph': graph, entity_graph: graph,
  };
}

export function osirisGateConfig(opts: { authorisedTargets?: readonly string[] } = {}): GateConfig {
  const view: ToolSpec = { tier: 'view', targetArgs: [] };
  return {
    authorisedTargets: opts.authorisedTargets ?? [],
    tools: {
      go_to: view, layers: view, find: view, scan: view, camera: view, highlight: view, show: view, markets: view,
      open: view, map_view: view, workspace: view, select: view, terrain: view, clear: view,
      // A forecast question spends model and search budget; one lifted verbatim from a feed needs a human.
      forecast: { tier: 'lookup-infra', targetArgs: ['question'] },
      recon: reconSpec,
      ...fusionTools(),
    },
  };
}

export interface OutcomeLike {
  result: { tool: string; ok: boolean; summary: string; data?: unknown };
}

export interface GateHooks {
  /** Consulted for require_approval. Default: not approved. */
  approve?: (d: Decision) => Promise<boolean>;
  onDecision?: (d: Decision, call: ToolCall) => void;
  /**
   * Admiralty grade recorded on each tool's output, by tool name. A tool with no entry is recorded as F6 ("cannot be
   * judged"), which carries no evidential weight until someone grades the source.
   */
  grades?: Readonly<Record<string, Grade>>;
}

/** Grade given to tool output nobody has graded. */
export const UNGRADED: Grade = { r: 'F', c: 6 };

/**
 * Wrap an OSIRIS `exec(call, signal)`. Tool results (which carry feed text) are
 * recorded as UNTRUSTED provenance before the model sees them, so any later
 * argument lifted from them is traced as tainted.
 */
export function gateOsirisExec<O extends OutcomeLike, C extends ToolCall>(
  ledger: ProvenanceLedger,
  cfg: GateConfig,
  exec: (call: C, signal?: AbortSignal) => Promise<O>,
  hooks: GateHooks = {},
  audit: AuditLog = new AuditLog(),
): { exec: (call: C, signal?: AbortSignal) => Promise<O | { result: OutcomeLike['result'] }>; gate: Gate } {
  const gate = new Gate(ledger, cfg, audit);
  return {
    gate,
    async exec(call, signal) {
      const decision = gate.decide(call);
      hooks.onDecision?.(decision, call);
      let allowed = decision.verdict === 'allow';
      if (decision.verdict === 'require_approval') {
        allowed = hooks.approve ? await hooks.approve(decision) : false;
        audit.append('approval', { tool: call.tool, approved: allowed });
      }
      if (!allowed) {
        return {
          result: {
            tool: call.tool,
            ok: false,
            summary: `Blocked by policy (${decision.verdict}): ${decision.reasons.join('; ')}`,
          },
        };
      }
      const out = await exec(call, signal);
      const grade = (hooks.grades && Object.hasOwn(hooks.grades, call.tool) ? hooks.grades[call.tool] : undefined) ?? UNGRADED;
      ledger.addUntrusted(`${out.result.summary}\n${safeJson(out.result.data)}`, { id: call.tool, kind: 'tool', grade });
      return out;
    },
  };
}

function safeJson(v: unknown): string {
  try {
    return v === undefined ? '' : JSON.stringify(v);
  } catch {
    return '';
  }
}
