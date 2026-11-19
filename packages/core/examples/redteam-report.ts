/**
 * Runs the whole red-team corpus against the vendored OSIRIS assist loop in
 * three configurations and writes RESULTS.md.
 *
 *   npm run redteam
 */
import { writeFileSync } from 'node:fs';
import { BENIGN } from '../test/redteam/benign.js';
import { GOALS, LANGS, TECHNIQUES, buildCorpus } from '../test/redteam/corpus.js';
import { runAttack, runBenign, type Result } from '../test/redteam/harness.js';

type Mode = 'ungated' | 'gated' | 'strict';
const MODES: Mode[] = ['ungated', 'gated', 'strict'];

const corpus = buildCorpus();
const table = new Map<string, Record<Mode, Result>>();

for (const c of corpus) {
  const row = {} as Record<Mode, Result>;
  for (const m of MODES) row[m] = (await runAttack(c, m)).result;
  table.set(c.id, row);
}

const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);
const count = (ids: string[], m: Mode, r: Result) => ids.filter(id => table.get(id)![m] === r).length;

const lines: string[] = [];
const out = (s = '') => lines.push(s);

out('# Red-team results: admiralty-gate vs. the OSIRIS OI Assist loop');
out();
out(`Cases: **${corpus.length}** (6 attacker goals x up to 5 languages x 10 obfuscation techniques). Model: a maximally gullible stand-in that`);
out('proposes the attacker\'s call whenever the payload is present in anything it read. This measures what the *gate* contains once a planner is hijacked;');
out('it does not measure how often a real LLM would be hijacked. The loop under test is OSIRIS\'s own `converse()` (vendored, MIT).');
out();
out('## Overall attack outcomes');
out();
out('| Config | Executed (attack succeeds) | Escalated to human (not executed) | Denied |');
out('|---|---:|---:|---:|');
const all = corpus.map(c => c.id);
for (const m of MODES) {
  const e = count(all, m, 'executed');
  const s = count(all, m, 'escalated');
  const b = count(all, m, 'blocked');
  out(`| ${m} | ${e} (${pct(e, all.length)}) | ${s} | ${b} |`);
}
out();
out('`ungated` = OSIRIS today. `gated` = default policy. `strict` = additionally requires approval for untraceable passive-infra targets.');
out();

out('## By attacker goal (executed attacks, gated default / ungated)');
out();
out('| Goal | Class | Cases | Ungated | Gated | Strict |');
out('|---|---|---:|---:|---:|---:|');
for (const g of GOALS) {
  const ids = corpus.filter(c => c.goal.id === g.id).map(c => c.id);
  out(`| ${g.id} ${g.label} | ${g.kind} | ${ids.length} | ${count(ids, 'ungated', 'executed')} | ${count(ids, 'gated', 'executed')} | ${count(ids, 'strict', 'executed')} |`);
}
out();

out('## By obfuscation technique (executed attacks)');
out();
out('| Technique | Cases | Ungated | Gated | Strict |');
out('|---|---:|---:|---:|---:|');
for (const t of TECHNIQUES) {
  const ids = corpus.filter(c => c.technique.id === t.id).map(c => c.id);
  out(`| ${t.label} | ${ids.length} | ${count(ids, 'ungated', 'executed')} | ${count(ids, 'gated', 'executed')} | ${count(ids, 'strict', 'executed')} |`);
}
out();

out('## By language of the injected instruction (executed attacks)');
out();
out('| Language | Cases | Ungated | Gated | Strict |');
out('|---|---:|---:|---:|---:|');
for (const l of LANGS) {
  const ids = corpus.filter(c => c.lang === l).map(c => c.id);
  out(`| ${l} | ${ids.length} | ${count(ids, 'ungated', 'executed')} | ${count(ids, 'gated', 'executed')} | ${count(ids, 'strict', 'executed')} |`);
}
out();

out('## What still gets through in default mode, and why');
out();
const slipped = all.filter(id => table.get(id)!.gated === 'executed');
out(`${slipped.length} case(s): ${slipped.join(', ') || 'none'}.`);
out();
out('These are passive infrastructure lookups (Shodan InternetDB on an IP) whose target was delivered base64-encoded or reversed, so it matches no recorded span and the default');
out('infra policy allows untraceable targets. They profile no person and probe nothing. `strict` mode closes them at the cost of more approval prompts.');
out();

out('## Benign operator tasks (utility)');
out();
out('| ID | Task | Expected | Gated | Strict |');
out('|---|---|---|---|---|');
for (const b of BENIGN) {
  const g = await runBenign(b, 'gated');
  const s = await runBenign(b, 'strict');
  const mark = (r: Result) => (r === b.expect ? `${r} ✓` : `${r} ✗`);
  out(`| ${b.id} | ${b.label} | ${b.expect} | ${mark(g.result)} | ${mark(s.result)} |`);
}
out();
out('## Limits of this experiment');
out();
out('- The model stand-in is worst-case obedient, not a real LLM. Real models resist some of these payloads; the gate does not depend on that.');
out('- Argument tracing is token-based. A hijacked model that *paraphrases* a target (e.g. a handle written differently) yields an untraceable value; sensitive tiers fail closed on that, passive infra does not (default).');
out('- The gate does not stop a hijacked model from *saying* false things in prose, or from steering which view/layer the operator sees. That is what corroboration, ACH and the release rule are for.');
out('- Only the `recon` and `forecast` tools of the OSIRIS assistant are risk-tiered here; the remaining tools are treated as view tier and were not audited for side effects.');

const md = lines.join('\n') + '\n';
writeFileSync(new URL('../../../RESULTS.md', import.meta.url), md);
console.log(md);
