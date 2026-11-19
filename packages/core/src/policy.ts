/**
 * Declarative policy: a JSON document an operator (not the model) writes and
 * reviews, turned into a GateConfig. Validation is strict: an unknown key or
 * a mistyped tier is an error, never a silently weaker policy.
 *
 * {
 *   "authorisedTargets": ["lab.example.org"],
 *   "trusted": ["text the operator vouches for, e.g. standing tasking"],
 *   "tools": {
 *     "whois":       { "tier": "lookup-infra",  "targetArgs": ["domain"] },
 *     "find_person": { "tier": "lookup-person", "targetArgs": "*" }
 *   },
 *   "defaultTool": { "tier": "lookup-person", "targetArgs": "*" },
 *   "onUnknownInfra": "require_approval"
 * }
 */
import type { GateConfig, Tier, ToolSpec, Verdict } from './guard.js';

export interface Policy {
  config: GateConfig;
  /** Operator-vouched text, to be added to the ledger as trusted at session start. */
  trusted: string[];
}

const TIERS: readonly Tier[] = ['view', 'lookup-infra', 'lookup-person', 'active-probe', 'publish'];
const VERDICTS: readonly Verdict[] = ['allow', 'require_approval', 'deny'];
const TOP_KEYS = new Set([
  'authorisedTargets', 'trusted', 'tools', 'defaultTool', 'onUnknown', 'onTaintedInfra', 'onTaintedSensitive',
  'onUnknownInfra', 'allowUnregistered', '$comment',
]);

function fail(msg: string): never {
  throw new Error(`Invalid policy: ${msg}`);
}

function strings(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) fail(`${where} must be an array of strings`);
  return v as string[];
}

function spec(v: unknown, where: string): ToolSpec {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${where} must be an object`);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== 'tier' && k !== 'targetArgs' && k !== '$comment') fail(`${where} has unknown key "${k}"`);
  if (!TIERS.includes(o.tier as Tier)) fail(`${where}.tier must be one of ${TIERS.join(', ')}`);
  const tier = o.tier as Tier;
  const targetArgs = o.targetArgs === undefined ? (tier === 'view' ? [] : '*') : o.targetArgs === '*' ? '*' : strings(o.targetArgs, `${where}.targetArgs`);
  return { tier, targetArgs };
}

function verdict(o: Record<string, unknown>, k: string): Verdict | undefined {
  if (o[k] === undefined) return undefined;
  if (!VERDICTS.includes(o[k] as Verdict)) fail(`${k} must be one of ${VERDICTS.join(', ')}`);
  return o[k] as Verdict;
}

export function parsePolicy(json: string | unknown): Policy {
  let v: unknown = json;
  if (typeof json === 'string') {
    try {
      v = JSON.parse(json);
    } catch (e) {
      fail(`not valid JSON (${(e as Error).message})`);
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('top level must be an object');
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!TOP_KEYS.has(k)) fail(`unknown key "${k}"`);

  const tools: Record<string, ToolSpec> = {};
  if (o.tools !== undefined) {
    if (!o.tools || typeof o.tools !== 'object' || Array.isArray(o.tools)) fail('tools must be an object');
    for (const [name, s] of Object.entries(o.tools as Record<string, unknown>)) tools[name] = spec(s, `tools.${name}`);
  }
  if (o.allowUnregistered !== undefined && typeof o.allowUnregistered !== 'boolean') fail('allowUnregistered must be a boolean');

  const config: GateConfig = { tools };
  if (o.authorisedTargets !== undefined) config.authorisedTargets = strings(o.authorisedTargets, 'authorisedTargets');
  if (o.defaultTool !== undefined) config.defaultTool = spec(o.defaultTool, 'defaultTool');
  if (o.allowUnregistered !== undefined) config.allowUnregistered = o.allowUnregistered as boolean;
  for (const k of ['onUnknown', 'onTaintedInfra', 'onTaintedSensitive', 'onUnknownInfra'] as const) {
    const x = verdict(o, k);
    if (x) config[k] = x;
  }
  return { config, trusted: o.trusted === undefined ? [] : strings(o.trusted, 'trusted') };
}
