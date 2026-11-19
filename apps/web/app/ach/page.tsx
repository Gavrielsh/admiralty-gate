'use client';

import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, ErrorNote, Panel, cx, inputCls } from '@/components/ui';
import { api, type AchResponse } from '@/lib/api';

interface H { id: string; label: string }
interface E { id: string; label: string; grade: string }
type Cells = Record<string, Record<string, number>>;

const EXAMPLE: { hypotheses: H[]; evidence: E[]; cells: Cells } = {
  hypotheses: [
    { id: 'h1', label: 'Local cash-out ring operating in person' },
    { id: 'h2', label: 'Compromised accounts, operator abroad' },
    { id: 'h3', label: 'Insider at the payment processor' },
  ],
  evidence: [
    { id: 'e1', label: 'Same devices seen across seven accounts', grade: 'B2' },
    { id: 'e2', label: 'Withdrawals at ATMs within 40 km', grade: 'B2' },
    { id: 'e3', label: 'Three logins through a VPN exit', grade: 'B3' },
    { id: 'e4', label: 'Anonymous post claiming an insider', grade: 'E4' },
    { id: 'e5', label: 'Accounts opened in the same week', grade: 'C3' },
  ],
  cells: {
    e1: { h1: 2, h2: -1, h3: 0 }, e2: { h1: 2, h2: -2, h3: 0 }, e3: { h1: 0, h2: 1, h3: 0 },
    e4: { h1: -1, h2: -1, h3: 2 }, e5: { h1: 1, h2: 1, h3: 1 },
  },
};

const SCALE = [-2, -1, 0, 1, 2];
const CELL: Record<number, { text: string; cls: string; title: string }> = {
  [-2]: { text: '−−', cls: 'border-rose-500/60 bg-rose-500/25 text-rose-100', title: 'strongly inconsistent' },
  [-1]: { text: '−', cls: 'border-rose-500/40 bg-rose-500/10 text-rose-200', title: 'inconsistent' },
  0: { text: '0', cls: 'border-line bg-canvas text-slate-500', title: 'neutral / not applicable' },
  1: { text: '+', cls: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200', title: 'consistent' },
  2: { text: '++', cls: 'border-cyan-500/60 bg-cyan-500/25 text-cyan-100', title: 'strongly consistent' },
};
let seq = 100;

export default function AchPage() {
  const [hyp, setHyp] = useState<H[]>(EXAMPLE.hypotheses);
  const [ev, setEv] = useState<E[]>(EXAMPLE.evidence);
  const [cells, setCells] = useState<Cells>(EXAMPLE.cells);
  const [res, setRes] = useState<AchResponse | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    const t = setTimeout(() => {
      api<AchResponse>('/api/ach', { method: 'POST', body: { hypotheses: hyp, evidence: ev.map(e => ({ id: e.id, label: e.label, ...(e.grade ? { grade: e.grade } : {}) })), cells } }).then(
        r => { setRes(r); setErr(''); },
        e => { setRes(null); setErr((e as Error).message); },
      );
    }, 200);
    return () => clearTimeout(t);
  }, [hyp, ev, cells]);

  const cycle = (e: string, h: string, dir: 1 | -1) =>
    setCells(c => {
      const cur = c[e]?.[h] ?? 0;
      const next = SCALE[(SCALE.indexOf(cur) + dir + SCALE.length) % SCALE.length]!;
      return { ...c, [e]: { ...c[e], [h]: next } };
    });
  const critical = useMemo(() => new Map(res?.result.critical.map(c => [c.id, c.leaderWithoutIt])), [res]);
  const diag = useMemo(() => new Map(res?.result.diagnosticity.map(d => [d.id, d])), [res]);
  const rank = useMemo(() => new Map(res?.result.ranking.map((r, i) => [r.id, { ...r, pos: i + 1 }])), [res]);
  const worst = Math.max(0.01, ...(res?.result.ranking.map(r => r.inconsistency) ?? []));
  const a = res?.attribution;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">ACH hypothesis matrix</h1>
          <p className="max-w-3xl text-xs text-muted">Analysis of Competing Hypotheses. You (or a model) fill the cells; the ranking is arithmetic. Hypotheses are ranked by how much weighted evidence is <b className="text-text">inconsistent</b> with them, because consistent evidence usually fits several explanations.</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => { setHyp(EXAMPLE.hypotheses); setEv(EXAMPLE.evidence); setCells(EXAMPLE.cells); }}>Load example</Button>
          <Button onClick={() => setHyp(h => [...h, { id: `h${++seq}`, label: 'New hypothesis' }])}>+ hypothesis</Button>
          <Button onClick={() => setEv(e => [...e, { id: `e${++seq}`, label: 'New evidence', grade: '' }])}>+ evidence</Button>
        </div>
      </div>
      {err && <div className="mb-3"><ErrorNote>{err}</ErrorNote></div>}

      {a && (
        <div role="status" className={cx('mb-4 flex flex-wrap items-center gap-4 rounded-lg border px-4 py-3', a.allowed ? 'border-emerald-500/40 bg-emerald-500/[0.07]' : 'border-rose-500/50 bg-rose-500/10')}>
          <div className={cx('flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 text-lg font-bold', a.allowed ? 'border-emerald-400 text-emerald-300' : 'border-rose-400 text-rose-300')}>{a.allowed ? '✓' : '✕'}</div>
          <div className="min-w-0 flex-1">
            <div className={cx('text-sm font-semibold', a.allowed ? 'text-emerald-200' : 'text-rose-200')}>
              {a.allowed ? 'Attribution may be stated' : 'Attribution blocked: premature'} · leading: {hyp.find(h => h.id === a.leader)?.label ?? a.leader}
            </div>
            {a.reasons.length > 0
              ? <ul className="mt-1 space-y-0.5 text-xs text-text/90">{a.reasons.map((r, i) => <li key={i}>— {r}</li>)}</ul>
              : <p className="mt-0.5 text-xs text-muted">Clear lead ({res!.result.margin.toFixed(2)}), enough discriminating evidence, and no weak item is load-bearing.</p>}
          </div>
        </div>
      )}

      <Panel title="Matrix" right={<span className="text-[11px] text-muted">click a cell to change it · shift-click to go back</span>}>
        <div className="overflow-x-auto p-3">
          <table className="w-full min-w-[760px] border-separate border-spacing-1 text-xs">
            <thead>
              <tr>
                <th className="w-[34%] text-left align-bottom text-[10.5px] font-medium uppercase tracking-wider text-muted">Evidence · grade</th>
                {hyp.map(h => {
                  const r = rank.get(h.id);
                  return (
                    <th key={h.id} className={cx('rounded-md border p-2 text-left align-top font-normal', r?.pos === 1 ? 'border-cyan-500/50 bg-cyan-500/10' : 'border-line bg-canvas/50')}>
                      <div className="flex items-start gap-1">
                        <textarea aria-label="Hypothesis" rows={2} className="w-full resize-none bg-transparent text-[12.5px] font-medium text-text" value={h.label} onChange={e => setHyp(x => x.map(y => (y.id === h.id ? { ...y, label: e.target.value } : y)))} />
                        <button aria-label={`Remove ${h.label}`} className="text-muted hover:text-rose-300" onClick={() => setHyp(x => x.filter(y => y.id !== h.id))}>✕</button>
                      </div>
                      {r && (
                        <div className="mt-1.5" title={`Weighted inconsistency ${r.inconsistency.toFixed(2)} (lower is better); consistency ${r.consistency.toFixed(2)}`}>
                          <div className="flex items-center justify-between text-[10.5px] text-muted"><span>{r.pos === 1 ? 'least contradicted' : `rank ${r.pos}`}</span><span className="font-mono text-text">{r.inconsistency.toFixed(2)}</span></div>
                          <div className="mt-0.5 h-1.5 rounded-sm bg-canvas"><span className="block h-1.5 rounded-r-[3px] bg-rose-400/80" style={{ width: `${Math.max(2, (r.inconsistency / worst) * 100)}%` }} /></div>
                        </div>
                      )}
                    </th>
                  );
                })}
                <th className="w-28 text-left align-bottom text-[10.5px] font-medium uppercase tracking-wider text-muted">Diagnostic value</th>
              </tr>
            </thead>
            <tbody>
              {ev.map(e => {
                const d = diag.get(e.id);
                const crit = critical.get(e.id);
                return (
                  <tr key={e.id}>
                    <td className={cx('rounded-md border p-1.5', crit ? 'border-amber-500/60 bg-amber-500/10' : 'border-line bg-canvas/50')}>
                      <div className="flex items-center gap-1.5">
                        <input aria-label="Evidence" className="min-w-0 flex-1 bg-transparent text-[12.5px] text-text" value={e.label} onChange={x => setEv(v => v.map(y => (y.id === e.id ? { ...y, label: x.target.value } : y)))} />
                        <input aria-label="Admiralty grade" placeholder="—" title="Admiralty grade, e.g. B2. Empty = ungraded (weight 0.5)" className={cx(inputCls, '!w-12 !px-1 !py-0.5 text-center font-mono !text-[11px]')} value={e.grade} onChange={x => setEv(v => v.map(y => (y.id === e.id ? { ...y, grade: x.target.value.toUpperCase().slice(0, 2) } : y)))} />
                        <button aria-label={`Remove ${e.label}`} className="text-muted hover:text-rose-300" onClick={() => setEv(v => v.filter(y => y.id !== e.id))}>✕</button>
                      </div>
                      {crit && <div className="mt-1 flex items-center gap-1.5"><Badge tone="amber">CRITICAL</Badge><span className="text-[10.5px] text-amber-100/90">without it the leader becomes {hyp.find(h => crit.startsWith(h.id))?.label ?? crit}{crit.endsWith('(tie)') ? ' (tie)' : ''}</span></div>}
                    </td>
                    {hyp.map(h => {
                      const v = cells[e.id]?.[h.id] ?? 0;
                      const c = CELL[v]!;
                      return (
                        <td key={h.id} className="p-0">
                          <button title={`${c.title} — click to change`} aria-label={`${e.label} vs ${h.label}: ${c.title}`} onClick={x => cycle(e.id, h.id, x.shiftKey ? -1 : 1)}
                            className={cx('h-11 w-full rounded-md border font-mono text-sm font-semibold transition-colors hover:brightness-125', c.cls)}>{c.text}</button>
                        </td>
                      );
                    })}
                    <td className="px-1" title={d ? `weight ${d.weight.toFixed(2)} × spread across hypotheses` : ''}>
                      {d && (d.diagnosticity === 0
                        ? <span className="text-[10.5px] text-slate-500">none: fits every hypothesis equally</span>
                        : <div><div className="h-1.5 rounded-sm bg-canvas"><span className="block h-1.5 rounded-r-[3px]" style={{ width: `${Math.min(100, (d.diagnosticity / 3.6) * 100)}%`, background: '#3987e5' }} /></div><div className="mt-0.5 font-mono text-[10.5px] text-muted">{d.diagnosticity.toFixed(2)}</div></div>)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted">
            {SCALE.map(v => <span key={v} className="flex items-center gap-1.5"><span className={cx('inline-flex h-5 w-7 items-center justify-center rounded border font-mono text-[10px] font-semibold', CELL[v]!.cls)}>{CELL[v]!.text}</span>{CELL[v]!.title}</span>)}
            <span className="flex items-center gap-1.5"><Badge tone="amber">CRITICAL</Badge>removing this one item changes the leading hypothesis: verify it first</span>
          </div>
        </div>
      </Panel>
    </>
  );
}
