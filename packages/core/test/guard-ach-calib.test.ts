import { describe, expect, it } from 'vitest';
import {
  Gate,
  ProvenanceLedger,
  ach,
  applyPlatt,
  baseRateBrier,
  brier,
  ece,
  fillCells,
  fitPlatt,
  guarded,
  logLoss,
  osirisGateConfig,
  parseGrade,
  readForecastLedger,
  reconToolId,
  reliabilityTable,
  skillScore,
  type Cell,
  type Resolved,
} from '../src/index.js';

const wire = { id: 'wire', kind: 'feed' as const };

describe('gate: tiering by provenance', () => {
  const cfg = osirisGateConfig({ authorisedTargets: ['lab.example.org'] });

  it('operator-typed targets run; feed-only person targets are denied; encoded ones need approval', () => {
    const l = new ProvenanceLedger();
    l.addTrusted('dns for example.com and github user alice_public');
    l.addUntrusted('Local activist known as private_person_77 posted again', wire);
    const g = new Gate(l, cfg);

    expect(g.decide({ tool: 'recon', args: { tool: 'dns', target: 'example.com' } }).verdict).toBe('allow');
    expect(g.decide({ tool: 'recon', args: { tool: 'github', target: 'alice_public' } }).verdict).toBe('allow');
    expect(g.decide({ tool: 'recon', args: { tool: 'username', target: 'private_person_77' } }).verdict).toBe('deny');
    // paraphrased / decoded: not in any span, person tier fails closed
    expect(g.decide({ tool: 'recon', args: { tool: 'username', target: 'someone_else_1' } }).verdict).toBe('require_approval');
  });

  it('aliases cannot dodge the tiering (breach -> leaks, port_scan -> shodan)', () => {
    expect(reconToolId('breach')).toBe('leaks');
    const l = new ProvenanceLedger();
    l.addUntrusted('contact jane.doe@example.org for details', wire);
    const g = new Gate(l, cfg);
    expect(g.decide({ tool: 'recon', args: { tool: 'breach', target: 'jane.doe@example.org' } }).verdict).toBe('deny');
    expect(g.decide({ tool: 'recon', args: { tool: 'Email', target: 'jane.doe@example.org' } }).verdict).toBe('deny');
  });

  it('unknown recon sub-tools fail closed as active probes', () => {
    const l = new ProvenanceLedger();
    l.addTrusted('probe thing.example.net');
    const g = new Gate(l, cfg);
    const d = g.decide({ tool: 'recon', args: { tool: 'nuke_everything', target: 'thing.example.net' } });
    expect(d.tier).toBe('active-probe');
    expect(d.verdict).toBe('deny'); // not an authorised target
  });

  it('active probes need BOTH operator provenance and an authorised target', () => {
    const l = new ProvenanceLedger();
    l.addTrusted('scan box.lab.example.org and also scan stranger.example.net');
    const g = new Gate(l, cfg);
    expect(g.decide({ tool: 'recon', args: { tool: 'vuln', target: 'box.lab.example.org' } }).verdict).toBe('allow');
    const d = g.decide({ tool: 'recon', args: { tool: 'vuln', target: 'stranger.example.net' } });
    expect(d.verdict).toBe('deny');
    expect(d.reasons.join(' ')).toMatch(/authorised-target/);
  });

  it('whole-token tracing: a substring of an operator token earns no trust on a person lookup', () => {
    const l = new ProvenanceLedger();
    l.addTrusted('look up alice_public');
    const g = new Gate(l, cfg);
    expect(g.decide({ tool: 'recon', args: { tool: 'username', target: 'lice_public' } }).verdict).toBe('require_approval');
  });

  it('feed-supplied infra targets need approval; strict mode also gates untraceable ones', () => {
    const l = new ProvenanceLedger();
    l.addUntrusted('suspicious server at 203.0.113.7', wire);
    const loose = new Gate(l, cfg);
    expect(loose.decide({ tool: 'recon', args: { tool: 'shodan', target: '203.0.113.7' } }).verdict).toBe('require_approval');
    expect(loose.decide({ tool: 'recon', args: { tool: 'shodan', target: '198.51.100.9' } }).verdict).toBe('allow');
    const strict = new Gate(l, { ...cfg, onUnknownInfra: 'require_approval' });
    expect(strict.decide({ tool: 'recon', args: { tool: 'shodan', target: '198.51.100.9' } }).verdict).toBe('require_approval');
  });

  it('unregistered tools are denied by default; view tools are allowed', () => {
    const g = new Gate(new ProvenanceLedger(), cfg);
    expect(g.decide({ tool: 'rm_rf', args: {} }).verdict).toBe('deny');
    expect(g.decide({ tool: 'go_to', args: { query: 'Cyprus' } }).verdict).toBe('allow');
  });

  it('guarded.run executes only on allow or an approved escalation, and audits both', async () => {
    const l = new ProvenanceLedger();
    l.addUntrusted('server 203.0.113.7', wire);
    const g = new Gate(l, cfg);
    let ran = 0;
    const exec = async () => {
      ran++;
      return 'ok';
    };
    const run = guarded<string>(g);
    const call = { tool: 'recon', args: { tool: 'shodan', target: '203.0.113.7' } };
    expect((await run.run(call, exec)).executed).toBe(false);
    expect((await run.run(call, exec, async () => true)).executed).toBe(true);
    expect(ran).toBe(1);
    expect(g.auditLog().records().some(r => r.kind === 'approval')).toBe(true);
  });
});

describe('ACH', () => {
  const hyps = [
    { id: 'H1', label: 'Exercise' },
    { id: 'H2', label: 'Preparation for deployment' },
    { id: 'H3', label: 'Deception' },
  ];
  const cells = (rows: Record<string, [Cell, Cell, Cell]>) =>
    Object.fromEntries(Object.entries(rows).map(([e, [a, b, c]]) => [e, { H1: a, H2: b, H3: c }]));

  it('ranks by least inconsistency and is deterministic', () => {
    const input = {
      hypotheses: hyps,
      evidence: [
        { id: 'E1', label: 'Units moved at night', grade: parseGrade('A2') },
        { id: 'E2', label: 'No announced exercise', grade: parseGrade('B2') },
        { id: 'E3', label: 'Field hospitals set up', grade: parseGrade('B2') },
        { id: 'E4', label: 'Press coverage of drills', grade: parseGrade('D4') },
      ],
      cells: cells({ E1: [1, 1, 1], E2: [-2, 1, 0], E3: [-1, 2, -1], E4: [1, 0, 1] }),
    };
    const r = ach(input);
    expect(r.leader).toBe('H2');
    expect(r.ranking.map(x => x.id)).toEqual(['H2', 'H3', 'H1']);
    expect(ach(input)).toEqual(r);
    expect(r.nonDiagnostic).toContain('E1');
  });

  it('flags load-bearing evidence: removing it flips the leader', () => {
    const input = {
      hypotheses: hyps,
      evidence: [
        { id: 'E1', label: 'Decisive but single-sourced', grade: parseGrade('C3') },
        { id: 'E2', label: 'Minor', grade: parseGrade('B2') },
      ],
      cells: cells({ E1: [-2, 0, 0], E2: [0, -1, 0] }),
    };
    const r = ach(input);
    expect(r.leader).toBe('H3');
    expect(r.critical.map(c => c.id)).toEqual(expect.arrayContaining(['E1', 'E2']));
  });

  it('weak-graded evidence moves the ranking less than strong evidence', () => {
    const mk = (g: string) =>
      ach({
        hypotheses: [
          { id: 'A', label: 'A' },
          { id: 'B', label: 'B' },
        ],
        evidence: [{ id: 'E', label: 'E', grade: parseGrade(g) }],
        cells: { E: { A: -2, B: 0 } },
      }).margin;
    expect(mk('A1')).toBeGreaterThan(mk('D4'));
  });

  it('rejects off-scale scorer output instead of coercing it', async () => {
    await expect(
      fillCells([{ id: 'H', label: 'H' }], [{ id: 'E', label: 'E' }], async () => 7),
    ).rejects.toThrow(/off-scale/);
    const ok = await fillCells([{ id: 'H', label: 'H' }], [{ id: 'E', label: 'E' }], async () => -1);
    expect(ok).toEqual({ E: { H: -1 } });
  });
});

describe('calibration', () => {
  const mk = (pairs: [number, 0 | 1][]): Resolved[] => pairs.map(([p, outcome]) => ({ p, outcome }));

  it('scoring rules', () => {
    expect(brier(mk([[1, 1], [0, 0]]))).toBe(0);
    expect(brier(mk([[1, 0], [0, 1]]))).toBe(1);
    expect(brier(mk([[0.5, 1], [0.5, 0]]))).toBeCloseTo(0.25);
    expect(logLoss(mk([[0.5, 1], [0.5, 0]]))).toBeCloseTo(Math.log(2));
    expect(baseRateBrier(mk([[0.9, 1], [0.1, 0]]))).toBeCloseTo(0.25);
    expect(skillScore(mk([[0.9, 1], [0.1, 0]]))).toBeGreaterThan(0.9);
  });

  it('an overconfident forecaster has high ECE and Platt scaling improves its Brier score', () => {
    // Says 0.9 but is right only ~60%; says 0.1 but is wrong ~40% of the time.
    const rs: Resolved[] = [];
    for (let i = 0; i < 200; i++) rs.push({ p: 0.9, outcome: i % 10 < 6 ? 1 : 0 });
    for (let i = 0; i < 200; i++) rs.push({ p: 0.1, outcome: i % 10 < 4 ? 1 : 0 });
    expect(ece(rs)).toBeGreaterThan(0.25);
    const m = fitPlatt(rs);
    expect(m.a).toBeLessThan(1); // shrink toward the middle
    const fixed = rs.map(r => ({ p: applyPlatt(r.p, m), outcome: r.outcome }));
    expect(brier(fixed)).toBeLessThan(brier(rs));
    expect(ece(fixed)).toBeLessThan(ece(rs));
  });

  it('a well-calibrated forecaster is left almost alone', () => {
    const rs: Resolved[] = [];
    for (let i = 0; i < 400; i++) rs.push({ p: 0.7, outcome: i % 10 < 7 ? 1 : 0 });
    const m = fitPlatt(rs);
    expect(applyPlatt(0.7, m)).toBeCloseTo(0.7, 1);
    expect(reliabilityTable(rs).length).toBe(1);
  });

  it('reads an OSIRIS-style ledger and reports that nothing is resolved', () => {
    const jsonl = [
      '{"kind":"brief","ts":1,"top_events":[]}',
      '{"kind":"forecast","id":"pred_a","statement":"x","probability":0.7,"ts":2,"resolve_after":3}',
      '{"kind":"forecast","id":"pred_b","statement":"y","probability":0.2,"ts":2}',
      'not json',
    ].join('\n');
    const { forecasts, resolutions } = readForecastLedger(jsonl);
    expect(forecasts).toHaveLength(2);
    expect(resolutions.size).toBe(0);
    const withRes = readForecastLedger(jsonl + '\n{"kind":"resolution","id":"pred_a","outcome":1}');
    expect(withRes.resolutions.get('pred_a')).toBe(1);
  });
});
