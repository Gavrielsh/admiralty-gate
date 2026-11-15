'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StatusLabel, StatusMark } from '@/components/StatusMark';
import { Badge, Button, ErrorNote, Panel, cx, inputCls } from '@/components/ui';
import { api, STATUS, type FusionStatus, type HeatCollection, type IncidentCollection, type IncidentProps, type IncidentStatus } from '@/lib/api';
import { useGate } from '@/lib/events';

const FusionMap = dynamic(() => import('@/components/FusionMap'), { ssr: false, loading: () => <div className="flex h-full items-center justify-center text-xs text-muted">Loading map…</div> });

const WINDOWS = [['all', 'Any time', 0], ['1h', 'Last hour', 3600e3], ['6h', 'Last 6 hours', 6 * 3600e3], ['24h', 'Last 24 hours', 24 * 3600e3]] as const;
const ago = (ms: number): string => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

export default function FusionPage() {
  const { fusionTick, connected } = useGate();
  const [incidents, setIncidents] = useState<IncidentCollection | null>(null);
  const [heat, setHeat] = useState<HeatCollection | null>(null);
  const [status, setStatus] = useState<FusionStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [released, setReleased] = useState<'all' | 'true' | 'false'>('all');
  const [kind, setKind] = useState<'all' | 'claim' | 'ring'>('all');
  const [minGrade, setMinGrade] = useState('');
  const [win, setWin] = useState<(typeof WINDOWS)[number][0]>('all');
  const [heatMode, setHeatMode] = useState<'ledger' | 'proxy' | 'off'>('ledger');
  const [inView, setInView] = useState(false);
  const bounds = useRef<[number, number, number, number] | null>(null);
  const [viewTick, setViewTick] = useState(0);

  const load = useCallback(async () => {
    const q = new URLSearchParams();
    if (released !== 'all') q.set('released', released);
    if (kind !== 'all') q.set('kind', kind);
    if (minGrade) q.set('minGrade', minGrade);
    const span = WINDOWS.find(w => w[0] === win)![2];
    if (span) q.set('since', String(Date.now() - span));
    if (inView && bounds.current) q.set('bbox', bounds.current.map(n => n.toFixed(4)).join(','));
    const hq = new URLSearchParams({ kind: 'ledger', cell: '0.02' });
    if (heatMode === 'proxy') hq.set('proxy', 'true');
    if (span) hq.set('since', String(Date.now() - span));
    try {
      const [inc, h, st] = await Promise.all([
        api<IncidentCollection>(`/api/geo/incidents?${q}`),
        heatMode === 'off' ? Promise.resolve(null) : api<HeatCollection>(`/api/geo/heatmap?${hq}`),
        api<FusionStatus>('/api/fusion/status'),
      ]);
      setIncidents(inc);
      setHeat(h);
      setStatus(st);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [released, kind, minGrade, win, heatMode, inView]);

  useEffect(() => {
    if (connected) void load();
  }, [load, fusionTick, connected, viewTick]);

  const seed = async () => {
    setBusy(true);
    try {
      await api('/api/fusion/demo', { method: 'POST' });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const list = useMemo(() => (incidents?.features ?? []).filter(f => f.geometry.type === 'Point').map(f => f.properties as IncidentProps), [incidents]);
  const sel = list.find(i => i.id === selected);
  const counts = useMemo(() => {
    const c: Record<IncidentStatus, number> = { released: 0, quarantined: 0, ring: 0 };
    for (const i of list) c[i.status]++;
    return c;
  }, [list]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Fusion map</h1>
          <p className="max-w-3xl text-xs text-muted">Incidents are placed only after their evidence has been clustered by independent origin and put through the release rule. A released incident and a quarantined one never look alike.</p>
        </div>
        <div className="flex items-center gap-2">
          {status && <Badge title="Where provenance is stored and how jobs are queued">{status.store} · {status.queue} · {status.items} items</Badge>}
          <Button onClick={load}>Refresh</Button>
          <Button tone="cyan" disabled={busy} onClick={seed} title="Loads an invented scenario: one corroborated event, one manufactured story, two fraud rings">{busy ? 'Loading…' : 'Load demo scenario'}</Button>
        </div>
      </div>
      {err && <div className="mb-3"><ErrorNote>{err}</ErrorNote></div>}

      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-xs">
        <label className="flex items-center gap-1.5 text-muted">Release
          <select className={cx(inputCls, '!w-auto !py-1 !text-xs')} value={released} onChange={e => setReleased(e.target.value as typeof released)}>
            <option value="all">all</option><option value="true">released only</option><option value="false">not released</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-muted">Kind
          <select className={cx(inputCls, '!w-auto !py-1 !text-xs')} value={kind} onChange={e => setKind(e.target.value as typeof kind)}>
            <option value="all">all</option><option value="claim">claims</option><option value="ring">rings</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-muted" title="Best supporting source must be at least this good on both axes">Min. grade
          <select className={cx(inputCls, '!w-auto !py-1 !text-xs')} value={minGrade} onChange={e => setMinGrade(e.target.value)}>
            <option value="">any</option>{['A1', 'A2', 'B2', 'B3', 'C3', 'D4'].map(g => <option key={g}>{g}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-muted">Time
          <select className={cx(inputCls, '!w-auto !py-1 !text-xs')} value={win} onChange={e => setWin(e.target.value as typeof win)}>
            {WINDOWS.map(w => <option key={w[0]} value={w[0]}>{w[1]}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-muted">Heatmap
          <select className={cx(inputCls, '!w-auto !py-1 !text-xs')} value={heatMode} onChange={e => setHeatMode(e.target.value as typeof heatMode)}>
            <option value="ledger">all ledger events</option><option value="proxy">proxy / VPN events</option><option value="off">off</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-muted"><input type="checkbox" checked={inView} onChange={e => setInView(e.target.checked)} /> only what is in view</label>
        <span className="ml-auto flex items-center gap-3">
          {(Object.keys(STATUS) as IncidentStatus[]).map(s => <span key={s} className="flex items-center gap-1.5 text-muted"><StatusMark status={s} /><b className="font-mono text-text">{counts[s]}</b> {STATUS[s].label.toLowerCase()}</span>)}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="relative h-[560px] overflow-hidden rounded-lg border border-line bg-panel xl:h-[680px]">
          <FusionMap incidents={incidents} heat={heat} selected={selected} onSelect={setSelected}
            onBounds={b => { bounds.current = b; if (inView) setViewTick(t => t + 1); }} />
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-line bg-panel/90 p-2.5 text-[11px] backdrop-blur">
            <div className="mb-1.5 font-semibold uppercase tracking-wider text-muted">Legend</div>
            {(Object.keys(STATUS) as IncidentStatus[]).map(s => (
              <div key={s} className="flex items-start gap-2 py-0.5"><span className="mt-0.5"><StatusMark status={s} /></span><span><b className="text-text">{STATUS[s].label}</b> <span className="text-muted">{STATUS[s].hint}</span></span></div>
            ))}
            <div className="flex items-center gap-2 py-0.5"><svg width="12" height="12" aria-hidden><line x1="0" y1="6" x2="12" y2="6" stroke={STATUS.ring.color} strokeWidth="1.5" strokeDasharray="2 2" /></svg><span className="text-muted">shared indicator between two ring members</span></div>
            <div className="flex items-center gap-2 py-0.5"><span className="h-3 w-3 rounded-sm" style={{ background: 'linear-gradient(90deg, rgba(28,92,171,.5), rgba(183,211,246,.95))' }} /><span className="text-muted">event density{heat ? ` (${heat.meta.events} events)` : ''}</span></div>
          </div>
          {list.length === 0 && incidents && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <p className="rounded-md border border-line bg-panel/90 px-4 py-3 text-sm text-muted">{status?.items ? 'No incident matches these filters.' : 'Nothing ingested yet. Load the demo scenario, or POST items to /api/ingest.'}</p>
            </div>
          )}
        </section>

        <div className="space-y-4">
          {sel && (
            <Panel title="Selected incident" right={<button className="text-[11px] text-cyan-300 hover:underline" onClick={() => setSelected(null)}>close</button>}>
              <div className="space-y-2.5 p-3 text-xs">
                <div className="flex items-center justify-between gap-2"><StatusLabel status={sel.status} /><span className="text-muted">{ago(sel.lastAt)}</span></div>
                <div className="break-words font-mono text-[13px] text-text">{sel.title}</div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                  <div><dt className="text-muted">Raw items</dt><dd className="font-mono text-sm">{sel.rawItems}</dd></div>
                  <div><dt className="text-muted">Independent origins</dt><dd className="font-mono text-sm">{sel.independentSupport}</dd></div>
                  {sel.kind === 'claim' && <div><dt className="text-muted">Confidence</dt><dd className="font-mono text-sm">{Math.round(sel.confidence * 100)}%</dd></div>}
                  <div><dt className="text-muted">Echo reduction</dt><dd className="font-mono text-sm">{Math.round(sel.echoReduction * 100)}%</dd></div>
                  <div><dt className="text-muted">Best grade</dt><dd className="font-mono text-sm">{sel.bestGrade ?? '—'}</dd></div>
                </dl>
                {sel.flags.length > 0 && <div className="flex flex-wrap gap-1">{sel.flags.map(f => <Badge key={f} tone="amber">{f}</Badge>)}</div>}
                {sel.reasons.length > 0 && (
                  <div>
                    <div className="mb-0.5 text-muted">{sel.released ? '' : 'Why it is held back'}</div>
                    <ul className="space-y-0.5 text-text/90">{sel.reasons.map((r, i) => <li key={i}>— {r}</li>)}</ul>
                  </div>
                )}
                {sel.sharedIndicators.length > 0 && (
                  <div>
                    <div className="mb-1 text-muted">Shared indicators</div>
                    <ul className="max-h-28 space-y-0.5 overflow-y-auto font-mono text-[11px] text-text/90">{sel.sharedIndicators.map(s => <li key={s} className="break-all">{s}</li>)}</ul>
                  </div>
                )}
                {sel.kind === 'claim' && <Link href={`/corroboration?claim=${encodeURIComponent(sel.title)}`} className="inline-block text-cyan-300 hover:underline">Open the corroboration breakdown →</Link>}
              </div>
            </Panel>
          )}
          <Panel title="Incidents" right={<span className="text-[11px] text-muted">{list.length} on the map</span>}>
            <ul className="max-h-[420px] divide-y divide-line/70 overflow-y-auto">
              {list.map(i => (
                <li key={i.id}>
                  <button onClick={() => setSelected(i.id)} className={cx('flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-raised/60', selected === i.id && 'bg-cyan-500/10')}>
                    <span className="mt-1"><StatusMark status={i.status} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs text-text">{i.title}</span>
                      <span className="block text-[11px] text-muted">{STATUS[i.status].label} · {i.rawItems} items → {i.independentSupport} independent{i.bestGrade ? ` · best ${i.bestGrade}` : ''}</span>
                    </span>
                  </button>
                </li>
              ))}
              {incidents?.meta.withoutLocation.map(i => (
                <li key={i.id} className="flex items-start gap-2.5 px-3 py-2 opacity-70">
                  <span className="mt-1"><StatusMark status={i.status} /></span>
                  <span className="min-w-0"><span className="block truncate font-mono text-xs">{i.title}</span><span className="block text-[11px] text-muted">no location: not on the map</span></span>
                </li>
              ))}
              {list.length === 0 && !incidents?.meta.withoutLocation.length && <li className="px-3 py-8 text-center text-xs text-muted">No incidents.</li>}
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}
