#!/usr/bin/env node
/**
 * admiralty-gate command line.
 *
 *   admiralty-gate mcp-proxy --policy policy.json [--audit audit.jsonl] [--operator-file operator.txt] -- <server command> [args...]
 *   admiralty-gate decide    --policy policy.json --tool <name> --args '<json>' [--user "<operator text>"] [--untrusted "<feed text>"]
 *   admiralty-gate ground    --report report.txt --sources sources.jsonl
 *   admiralty-gate verify-audit audit.jsonl
 */
import { readFileSync } from 'node:fs';
import { AuditLog } from './audit.js';
import { parseGrade } from './grades.js';
import { annotateReport, groundReport, summariseGrounding } from './ground.js';
import { Gate } from './guard.js';
import { runStdioProxy } from './mcp/stdio.js';
import { parsePolicy } from './policy.js';
import { ProvenanceLedger, type OriginKind } from './provenance.js';

const USAGE = `admiralty-gate: source-graded information-flow control for LLM agents

  mcp-proxy    --policy <file> [--audit <file>] [--operator-file <file>] -- <server command> [args...]
               Run an MCP server behind the gate. Point your MCP client at this command instead of the server.
  decide       --policy <file> --tool <name> --args '<json>' [--user <text>]... [--untrusted <text>]...
               Show what the gate would decide for one tool call. Exit code: 0 allow, 2 require_approval, 3 deny.
  ground       --report <file> --sources <jsonl>
               Trace each sentence of a report to its sources. Each JSONL line: {"text","id","kind","grade"?,"owner"?,"trusted"?}
  verify-audit <file>
               Verify a hash-chained audit log. Exit code 0 if intact.
`;

function flags(argv: string[]): { opts: Map<string, string[]>; rest: string[] } {
  const opts = new Map<string, string[]>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      opts.set(a.slice(2), [...(opts.get(a.slice(2)) ?? []), v]);
    } else rest.push(a);
  }
  return { opts, rest };
}

const one = (opts: Map<string, string[]>, k: string): string => {
  const v = opts.get(k)?.[0];
  if (v === undefined) throw new Error(`missing --${k}`);
  return v;
};

export async function main(argv: string[], out: (s: string) => void = s => process.stdout.write(s + '\n')): Promise<number> {
  const [cmd, ...tail] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    out(USAGE);
    return cmd ? 0 : 1;
  }
  const { opts, rest } = flags(tail);

  if (cmd === 'verify-audit') {
    const file = rest[0];
    if (!file) throw new Error('usage: admiralty-gate verify-audit <file>');
    const records = AuditLog.fromJsonl(readFileSync(file, 'utf8'));
    const v = AuditLog.verify(records);
    if (v.ok) {
      out(`OK: ${records.length} records, chain intact. Head: ${records.length ? records[records.length - 1]!.hash : '(empty)'}`);
      return 0;
    }
    out(`BROKEN at record ${v.at}: ${v.reason}`);
    return 1;
  }

  if (cmd === 'decide') {
    const policy = parsePolicy(readFileSync(one(opts, 'policy'), 'utf8'));
    const ledger = new ProvenanceLedger();
    for (const t of policy.trusted) ledger.addTrusted(t);
    for (const t of opts.get('user') ?? []) ledger.addTrusted(t);
    (opts.get('untrusted') ?? []).forEach((t, i) => ledger.addUntrusted(t, { id: `untrusted-${i + 1}`, kind: 'feed' }));
    const args: unknown = JSON.parse(opts.get('args')?.[0] ?? '{}');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('--args must be a JSON object');
    const d = new Gate(ledger, policy.config).decide({ tool: one(opts, 'tool'), args: args as Record<string, unknown> });
    out(`${d.verdict.toUpperCase()}  (tier: ${d.tier})`);
    for (const r of d.reasons) out(`  - ${r}`);
    return d.verdict === 'allow' ? 0 : d.verdict === 'require_approval' ? 2 : 3;
  }

  if (cmd === 'ground') {
    const ledger = new ProvenanceLedger();
    for (const line of readFileSync(one(opts, 'sources'), 'utf8').split('\n').filter(l => l.trim())) {
      const s = JSON.parse(line) as { text: string; id?: string; kind?: OriginKind; grade?: string; owner?: string; trusted?: boolean };
      if (s.trusted) ledger.addTrusted(s.text);
      else
        ledger.addUntrusted(s.text, {
          id: s.id ?? 'source',
          kind: s.kind && s.kind !== 'user' ? s.kind : 'web',
          ...(s.grade ? { grade: parseGrade(s.grade) } : {}),
          ...(s.owner ? { owner: s.owner } : {}),
        });
    }
    const gs = groundReport(readFileSync(one(opts, 'report'), 'utf8'), ledger);
    out(annotateReport(gs));
    out('');
    out(JSON.stringify(summariseGrounding(gs)));
    return 0;
  }

  if (cmd === 'mcp-proxy') {
    const [command, ...args] = rest;
    if (!command) throw new Error('usage: admiralty-gate mcp-proxy --policy <file> -- <server command> [args...]');
    const auditFile = opts.get('audit')?.[0];
    const operatorFile = opts.get('operator-file')?.[0];
    return runStdioProxy({
      policy: parsePolicy(readFileSync(one(opts, 'policy'), 'utf8')),
      command,
      args,
      ...(auditFile ? { auditFile } : {}),
      ...(operatorFile ? { operatorFile } : {}),
    });
  }

  out(USAGE);
  return 1;
}

const invoked = process.argv[1] ? /(^|[\\/])(cli\.(js|ts)|admiralty-gate)$/.test(process.argv[1]) : false;
if (invoked) {
  main(process.argv.slice(2)).then(
    code => {
      process.exitCode = code;
    },
    (e: Error) => {
      process.stderr.write(`admiralty-gate: ${e.message}\n`);
      process.exitCode = 1;
    },
  );
}
