'use client';

import { useState, type ReactNode } from 'react';
import { Badge, Button, ErrorNote, Panel, cx, inputCls } from '@/components/ui';
import { api, type GroundedSentence, type GroundingResult } from '@/lib/api';

interface Source { id: string; kind: string; grade: string; text: string }

const EXAMPLE_REPORT =
  'Dock workers at Limassol port began an indefinite strike on Monday. Cargo handling at Limassol is suspended and 41 vessels are waiting at anchor. The army will deploy within 48 hours.';
const EXAMPLE_SOURCES: Source[] = [
  { id: 'reuters', kind: 'feed', grade: 'B2', text: 'Dock workers at Limassol port began an indefinite strike on Monday over pay, the union said.' },
  { id: 'cyprus-mail', kind: 'web', grade: 'C2', text: 'An indefinite strike by dock workers began on Monday at Limassol port, the Cyprus Mail has learned.' },
  { id: 'cpa.gov.cy', kind: 'web', grade: 'A2', text: 'Cyprus ports authority confirms cargo handling at Limassol is suspended; 14 vessels are waiting at anchor.' },
];

const LEVEL: Record<GroundedSentence['level'], { label: string; mark: string; tone: 'green' | 'cyan' | 'amber' | 'red' | 'gray' }> = {
  verified: { label: '2+ independent sources', mark: 'bg-emerald-500/20 decoration-emerald-400', tone: 'green' },
  single: { label: 'single source', mark: 'bg-amber-500/20 decoration-amber-400', tone: 'amber' },
  weak: { label: 'partial match', mark: 'bg-orange-500/15 decoration-orange-400', tone: 'amber' },
  ungrounded: { label: 'no source', mark: 'bg-rose-500/20 decoration-rose-400', tone: 'red' },
  operator: { label: 'operator said it', mark: 'bg-cyan-500/15 decoration-cyan-400', tone: 'cyan' },
};

/** Sentence text with figures/identifiers that occur in no source shown as red badges. */
function withSpecifics(text: string, specifics: string[]): ReactNode {
  if (!specifics.length) return text;
  const esc = specifics.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length);
  const parts = text.split(new RegExp(`(${esc.join('|')})`, 'gi'));
  return parts.map((p, i) =>
    specifics.some(s => s.toLowerCase() === p.toLowerCase())
      ? <span key={i} title="Appears in none of the sources" className="mx-0.5 rounded border border-rose-400 bg-rose-600 px-1 font-mono text-[0.85em] font-bold text-white">{p}</span>
      : p,
  );
}

export default function GroundingPage() {
  const [report, setReport] = useState(EXAMPLE_REPORT);
  const [sources, setSources] = useState<Source[]>(EXAMPLE_SOURCES);
  const [result, setResult] = useState<GroundingResult | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const analyse = async () => {
    setBusy(true);
    setErr('');
    try {
      setResult(await api<GroundingResult>('/api/grounding', { method: 'POST', body: { report, sources } }));
      setPicked(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const edit = (i: number, patch: Partial<Source>) => {
    setSources(s => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    setResult(null);
  };
  const sel = picked !== null ? result?.sentences[picked] : undefined;
  const supporting = new Set(sel?.support.map(s => s.spanId));
  // The server skips empty sources, so map by position among the non-empty ones.
  const spanOf = (i: number) => (result ? result.sources[sources.slice(0, i + 1).filter(s => s.text.trim()).length - 1]?.spanId : undefined);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Grounding &amp; provenance inspector</h1>
          <p className="max-w-3xl text-xs text-muted">
            Which sources does each sentence of a generated report rest on? Matching is lexical: it shows where the words came from, not whether the sentence is true, and it misses paraphrase and translation.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => { setReport(EXAMPLE_REPORT); setSources(EXAMPLE_SOURCES); setResult(null); }}>Load example</Button>
          <Button tone="cyan" disabled={busy || !report.trim()} onClick={analyse}>{busy ? 'Analysing…' : 'Analyse grounding'}</Button>
        </div>
      </div>
      {err && <div className="mb-3"><ErrorNote>{err}</ErrorNote></div>}

      {result && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel px-4 py-2.5 text-xs">
          <span className="text-muted">{result.summary.sentences} sentences:</span>
          {(['verified', 'single', 'weak', 'ungrounded', 'operator'] as const).map(l => {
            const n = result.sentences.filter(s => s.level === l).length;
            return n > 0 && <Badge key={l} tone={LEVEL[l].tone}>{n} · {LEVEL[l].label}</Badge>;
          })}
          {result.summary.withUnsupportedSpecifics > 0 && (
            <Badge tone="red">{result.summary.withUnsupportedSpecifics} with figures/IDs found in no source</Badge>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Generated report" right={result ? <button className="text-[11px] text-cyan-300 hover:underline" onClick={() => setResult(null)}>edit text</button> : undefined}>
          {result ? (
            <div className="p-4">
              <p className="text-[15px] leading-8">
                {result.sentences.map((s, i) => (
                  <button key={i} onClick={() => setPicked(picked === i ? null : i)} aria-pressed={picked === i} dir="auto"
                    className={cx('mr-1 rounded px-1 text-left underline decoration-2 underline-offset-4 transition-shadow', LEVEL[s.level].mark, picked === i && 'ring-2 ring-cyan-400')}>
                    {withSpecifics(s.text, s.unsupportedSpecifics)}
                  </button>
                ))}
              </p>
              <p className="mt-3 text-[11px] text-slate-500">Click a sentence to see its sources.</p>
              {sel && (
                <div className="mt-3 rounded-md border border-line bg-canvas/60 p-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={LEVEL[sel.level].tone}>{LEVEL[sel.level].label}</Badge>
                    <span className="text-muted">independent sources: <b className="text-text">{sel.independentOrigins}</b></span>
                    <span className="text-muted">word overlap: <b className="text-text">{Math.round(sel.overlap * 100)}%</b></span>
                    {sel.bestGrade && <span className="text-muted">best grade: <b className="text-text">{sel.bestGrade}</b></span>}
                    {sel.fromFlaggedSource && <Badge tone="amber">source has injection-style text</Badge>}
                  </div>
                  {sel.support.length > 0 ? (
                    <ul className="mt-2 space-y-0.5 font-mono text-[11.5px] text-muted">
                      {sel.support.map(s => <li key={s.spanId}>{s.origin.kind}:{s.origin.id} · {Math.round(s.overlap * 100)}%</li>)}
                    </ul>
                  ) : <p className="mt-2 text-rose-300">No recorded source contains this sentence. It originated with the model.</p>}
                  {sel.unsupportedSpecifics.length > 0 && (
                    <p className="mt-2 text-rose-300">Not in any source: <span className="font-mono">{sel.unsupportedSpecifics.join(', ')}</span></p>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="p-3">
              <textarea className={cx(inputCls, 'min-h-[260px] leading-relaxed')} dir="auto" value={report} onChange={e => setReport(e.target.value)} placeholder="Paste the report a model wrote…" />
            </div>
          )}
        </Panel>

        <Panel title="Raw sources" right={<button className="text-[11px] text-cyan-300 hover:underline" onClick={() => { setSources(s => [...s, { id: `source-${s.length + 1}`, kind: 'web', grade: '', text: '' }]); setResult(null); }}>+ add source</button>}>
          <ul className="space-y-2 p-3">
            {sources.map((s, i) => {
              const hit = sel ? supporting.has(spanOf(i) ?? '') : false;
              return (
                <li key={i} className={cx('rounded-md border p-2 transition-colors', hit ? 'border-cyan-400 bg-cyan-500/10' : sel ? 'border-line opacity-50' : 'border-line bg-canvas/40')}>
                  <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                    <input aria-label="Source id" className={cx(inputCls, '!w-36 font-mono !text-xs')} value={s.id} onChange={e => edit(i, { id: e.target.value })} />
                    <select aria-label="Source kind" className={cx(inputCls, '!w-auto !text-xs')} value={s.kind} onChange={e => edit(i, { kind: e.target.value })}>
                      {['feed', 'web', 'telegram', 'sensor', 'tool', 'file'].map(k => <option key={k}>{k}</option>)}
                    </select>
                    <input aria-label="Admiralty grade" title="Admiralty grade: reliability A-F, credibility 1-6" placeholder="grade e.g. B2" className={cx(inputCls, '!w-28 font-mono !text-xs')} value={s.grade} onChange={e => edit(i, { grade: e.target.value.toUpperCase() })} />
                    {hit && <Badge tone="cyan">supports the selected sentence</Badge>}
                    <button aria-label={`Remove source ${s.id}`} className="ml-auto px-1 text-muted hover:text-rose-300" onClick={() => { setSources(x => x.filter((_, j) => j !== i)); setResult(null); }}>✕</button>
                  </div>
                  <textarea className={cx(inputCls, 'leading-relaxed')} rows={3} dir="auto" value={s.text} onChange={e => edit(i, { text: e.target.value })} placeholder="Source text…" />
                </li>
              );
            })}
            {sources.length === 0 && <li className="py-8 text-center text-xs text-muted">No sources. Every sentence will be ungrounded.</li>}
          </ul>
        </Panel>
      </div>

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-muted">
        {(Object.keys(LEVEL) as (keyof typeof LEVEL)[]).map(l => (
          <span key={l} className="flex items-center gap-1.5"><span className={cx('h-3 w-5 rounded-sm', LEVEL[l].mark)} />{LEVEL[l].label}</span>
        ))}
        <span className="flex items-center gap-1.5"><span className="rounded border border-rose-400 bg-rose-600 px-1 font-mono text-[10px] font-bold text-white">41</span>figure or identifier in no source</span>
      </div>
    </>
  );
}
