'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Badge, ErrorNote, Panel, cx, inputCls } from '@/components/ui';
import { api, type CorroborationView } from '@/lib/api';
import { useGate } from '@/lib/events';

const BAR = '#3987e5';
const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** One horizontal bar: label and value in text ink, the mark carries only magnitude. */
function Bar({ label, value, max, suffix, note }: { label: string; value: number; max: number; suffix?: string; note?: string }) {
  return (
    <div className="group grid grid-cols-[minmax(70px,150px)_minmax(0,1fr)_40px] items-center gap-3 text-xs" title={note ?? `${label}: ${value}${suffix ?? ''}`}>
      <span className="truncate text-muted">{label}</span>
      <span className="h-3 rounded-sm bg-canvas">
        <span className="block h-3 rounded-r-[4px] transition-[width] group-hover:brightness-125" style={{ width: `${max ? Math.max(1.5, (value / max) * 100) : 0}%`, background: BAR }} />
      </span>
      <span className="text-right font-mono text-text">{value}{suffix}</span>
    </div>
  );
}

/** 0..1 meter with the release threshold marked. */
function Meter({ label, value, threshold, note }: { label: string; value: number; threshold?: number; note: string }) {
  return (
    <div title={note}>
      <div className="mb-1 flex items-baseline justify-between text-xs"><span className="text-muted">{label}</span><span className="font-mono text-sm text-text">{pct(value)}</span></div>
      <div className="relative h-2.5 rounded-sm bg-canvas">
        <span className="block h-2.5 rounded-r-[4px]" style={{ width: `${Math.max(1, value * 100)}%`, background: BAR }} />
        {threshold !== undefined && <span className="absolute -top-1 h-[18px] w-px bg-slate-300" style={{ left: `${threshold * 100}%` }} aria-hidden />}
      </div>
      {threshold !== undefined && <div className="mt-1 text-[10.5px] text-slate-500">line: release needs {pct(threshold)}</div>}
    </div>
  );
}

function Inner() {
  const params = useSearchParams();
  const { connected, fusionTick } = useGate();
  const [claims, setClaims] = useState<string[]>([]);
  const [claim, setClaim] = useState(params.get('claim') ?? '');
  const [indicators, setIndicators] = useState(true);
  const [burst, setBurst] = useState(true);
  const [view, setView] = useState<CorroborationView | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!connected) return;
    api<{ claims: string[] }>('/api/provenance?limit=1').then(r => {
      setClaims(r.claims);
      setClaim(c => c || r.claims[0] || '');
    }, e => setErr((e as Error).message));
  }, [connected, fusionTick]);

  const load = useCallback(async () => {
    if (!claim) return setView(null);
    try {
      setView(await api<CorroborationView>('/api/corroborate', { method: 'POST', body: { claim, options: { indicators, burstWindowMs: burst ? 600000 : null } } }));
      setErr('');
    } catch (e) {
      setView(null);
      setErr((e as Error).message);
    }
  }, [claim, indicators, burst]);
  useEffect(() => {
    if (connected) void load();
  }, [load, connected, fusionTick]);

  const clusters = useMemo(() => {
    const m = new Map<string, CorroborationView['members']>();
    for (const x of view?.members ?? []) m.set(x.cluster, [...(m.get(x.cluster) ?? []), x]);
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [view]);
  const linkFor = (id: string) => view?.assessment.links.filter(l => l.a === id || l.b === id).map(l => l.reason) ?? [];
  const grades = Object.entries(view?.gradeDistribution ?? {});
  const maxGrade = Math.max(1, ...grades.map(g => g[1]));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Echo-chamber &amp; corroboration breakdown</h1>
          <p className="max-w-3xl text-xs text-muted">How many sources there appear to be, and how many remain once reposts, shared owners, shared indicators and synchronised bursts are counted as one origin.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select aria-label="Claim" className={cx(inputCls, '!w-64 max-w-full font-mono !text-xs')} value={claim} onChange={e => setClaim(e.target.value)}>
            {claims.length === 0 && <option value="">no claims ingested</option>}
            {claims.map(c => <option key={c}>{c}</option>)}
          </select>
          <label className="flex items-center gap-1.5 text-muted" title="Merge sources that share a hard indicator (hub channel, wallet, device)"><input type="checkbox" checked={indicators} onChange={e => setIndicators(e.target.checked)} /> shared indicators</label>
          <label className="flex items-center gap-1.5 text-muted" title="Merge similar or indicator-linked posts made within 10 minutes"><input type="checkbox" checked={burst} onChange={e => setBurst(e.target.checked)} /> time bursts</label>
        </div>
      </div>
      {err && <div className="mb-3"><ErrorNote>{err}</ErrorNote></div>}
      {!view && !err && <p className="rounded-lg border border-line bg-panel px-4 py-12 text-center text-sm text-muted">{claims.length ? 'Loading…' : 'No claims yet. Load the demo scenario on the Fusion map, or ingest items with a "claim" key.'}</p>}

      {view && (
        <>
          <div role="status" className={cx('mb-4 flex flex-wrap items-center gap-4 rounded-lg border px-4 py-3', view.release.allowed ? 'border-emerald-500/40 bg-emerald-500/[0.07]' : 'border-amber-500/50 bg-amber-500/[0.07]')}>
            <div className={cx('flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 text-xl', view.release.allowed ? 'border-emerald-400 text-emerald-300' : 'border-amber-400 text-amber-300')}>{view.release.allowed ? '✓' : '‖'}</div>
            <div className="min-w-0 flex-1">
              <div className={cx('text-sm font-semibold', view.release.allowed ? 'text-emerald-200' : 'text-amber-200')}>
                {view.release.allowed ? 'May be released' : 'Held back by the release rule'} · assessed “{view.assessment.phrase}”
              </div>
              {view.release.reasons.length > 0 && <ul className="mt-1 space-y-0.5 text-xs text-text/90">{view.release.reasons.map((r, i) => <li key={i}>— {r}</li>)}</ul>}
            </div>
            <div className="flex flex-wrap gap-1">{view.assessment.flags.map(f => <Badge key={f} tone="amber">{f}</Badge>)}</div>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Panel title="Source volume vs independent origins">
              <div className="space-y-3 p-4">
                <div className="flex flex-wrap items-end gap-4">
                  <div><div className="font-mono text-3xl font-semibold leading-none">{view.assessment.rawSupportItems}</div><div className="mt-1 text-[11px] text-muted">supporting items</div></div>
                  <div className="pb-1 text-xl text-slate-500">→</div>
                  <div><div className="font-mono text-3xl font-semibold leading-none">{view.assessment.independentSupport}</div><div className="mt-1 text-[11px] text-muted">independent origins</div></div>
                  <div className="ml-auto text-right"><div className="font-mono text-xl font-semibold leading-none">{pct(view.echoReduction)}</div><div className="mt-1 text-[11px] text-muted">were echoes</div></div>
                </div>
                <div className="space-y-1.5 border-t border-line pt-3">
                  <Bar label="Supporting items" value={view.assessment.rawSupportItems} max={view.rawSources} />
                  <Bar label="Independent support" value={view.assessment.independentSupport} max={view.rawSources} />
                  <Bar label="Independent contradiction" value={view.assessment.independentContradiction} max={view.rawSources} />
                </div>
              </div>
            </Panel>

            <Panel title="Noisy-OR confidence">
              <div className="space-y-4 p-4">
                <Meter label="Confidence" value={view.noisyOr.confidence} threshold={0.8} note="support × (1 − contradiction). Not a calibrated probability until fitted to outcomes." />
                <Meter label="Support" value={view.noisyOr.support} note="1 − Π(1 − weight) over independent supporting origins; an echo adds nothing" />
                <Meter label="Contradiction" value={view.noisyOr.contradiction} threshold={0.3} note="Same combination over independent contradicting origins; above 30% the claim is held" />
              </div>
            </Panel>

            <Panel title="Admiralty grade distribution">
              <div className="space-y-1.5 p-4">
                {grades.map(([g, n]) => <Bar key={g} label={g} value={n} max={maxGrade} note={`${n} item(s) graded ${g}: source reliability ${g[0]}, information credibility ${g[1]}`} />)}
                <p className="pt-2 text-[10.5px] leading-snug text-slate-500">Letter: reliability of the source (A best). Digit: credibility of the information (1 best). F6 means nobody graded the source; it carries no weight.</p>
              </div>
            </Panel>
          </div>

          <Panel title={`Origins (${clusters.length})`} className="mt-4" right={<span className="text-[11px] text-muted">each box counts once</span>}>
            <div className="grid grid-cols-1 gap-3 p-3 lg:grid-cols-2">
              {clusters.map(([id, members]) => {
                const c = view.assessment.clusters.filter(x => x.id === id);
                return (
                  <div key={id} className="min-w-0 rounded-md border border-line bg-canvas/50">
                    <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5 text-[11px]">
                      <span className="font-semibold text-text">{members.length} item{members.length > 1 ? 's' : ''}</span>
                      {c.map(x => <Badge key={x.stance} className="!whitespace-normal" tone={x.stance === 'supports' ? 'cyan' : 'red'}>{x.stance} · weight {x.weight.toFixed(2)} · best {x.bestGrade}</Badge>)}
                      {members.length > 1 && <span className="text-muted">counted as one origin</span>}
                    </div>
                    <table className="w-full table-fixed text-left text-[11.5px]">
                      <tbody>
                        {members.map(m => {
                          const why = [...new Set(linkFor(m.id))];
                          const geo = view.assessment.geoFlags[m.id];
                          return (
                            <tr key={m.id} className="border-b border-line/50 align-top last:border-0">
                              <td className="w-32 px-3 py-1.5 font-mono text-text"><div className="truncate" title={m.sourceId}>{m.sourceId}</div><div className="text-muted">{m.sourceType} · {m.grade}</div></td>
                              <td className="px-2 py-1.5 text-muted"><span className="line-clamp-2" dir="auto">{m.text}</span>
                                <span className="mt-0.5 flex flex-wrap gap-1">
                                  {why.map(w => <Badge key={w}>{w}</Badge>)}
                                  {geo?.map((g, i) => <Badge key={i} tone="red" className="!whitespace-normal !leading-tight">{g.kind}{g.place ? `: ${g.distanceKm} km from ${g.place}` : g.distanceKm ? `: ${g.distanceKm} km` : ''}</Badge>)}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          </Panel>
        </>
      )}
    </>
  );
}

export default function CorroborationPage() {
  return <Suspense fallback={null}><Inner /></Suspense>;
}
