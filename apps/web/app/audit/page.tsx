'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, ErrorNote, Panel, cx, inputCls, short } from '@/components/ui';
import { api, type AuditEntry, type AuditView } from '@/lib/api';
import { useGate } from '@/lib/events';

const VERDICT = { allow: ['green', 'ALLOW'], deny: ['red', 'BLOCK'], require_approval: ['amber', 'ELICIT'] } as const;

function decision(e: AuditEntry) {
  const d = e.data ?? {};
  if (typeof d.verdict === 'string' && d.verdict in VERDICT) {
    const [tone, label] = VERDICT[d.verdict as keyof typeof VERDICT];
    return <Badge tone={tone}>{label}</Badge>;
  }
  if (typeof d.approved === 'boolean') return <Badge tone={d.approved ? 'green' : 'red'}>{d.approved ? 'human approved' : 'not approved'}</Badge>;
  return <span className="text-slate-600">—</span>;
}
const detail = (e: AuditEntry): string => {
  const d = e.data ?? {};
  if (e.unparseable) return e.unparseable;
  if (Array.isArray(d.reasons)) return (d.reasons as string[]).join('; ');
  return Object.entries(d).filter(([k]) => k !== 'tool').map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ');
};

export default function AuditPage() {
  const { auditTick, connected } = useGate();
  const [view, setView] = useState<AuditView | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('all');
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api<AuditView>('/api/audit'));
      setCheckedAt(Date.now());
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (connected) void load();
  }, [load, auditTick, connected]);

  const act = async (path: string) => {
    try {
      await api(path, { method: 'POST' });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const kinds = useMemo(() => ['all', ...new Set(view?.entries.map(e => e.kind ?? 'unparseable') ?? [])], [view]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (view?.entries ?? [])
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => (kind === 'all' || (e.kind ?? 'unparseable') === kind) && (!needle || JSON.stringify(e).toLowerCase().includes(needle)))
      .reverse();
  }, [view, q, kind]);
  const broken = view && !view.chainValid ? view.brokenAt! : -1;

  return (
    <>
      <div className="mb-4">
        <h1 className="text-lg font-semibold">Tamper-evident audit log</h1>
        <p className="max-w-3xl text-xs text-muted">Every decision and approval is appended to a file. Each record carries the SHA-256 hash of the one before it, so an edit, deletion or reorder breaks the chain from that record on.</p>
      </div>
      {err && <div className="mb-3"><ErrorNote>{err}</ErrorNote></div>}

      {view && (
        <div role="status" className={cx('mb-4 flex flex-wrap items-center gap-4 rounded-lg border px-4 py-3', view.chainValid ? 'border-emerald-500/40 bg-emerald-500/[0.07]' : 'border-rose-500/60 bg-rose-500/10')}>
          <div className={cx('flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 text-xl', view.chainValid ? 'border-emerald-400 text-emerald-300' : 'border-rose-400 text-rose-300')}>{view.chainValid ? '✓' : '!'}</div>
          <div className="min-w-0 flex-1">
            <div className={cx('text-sm font-semibold', view.chainValid ? 'text-emerald-200' : 'text-rose-200')}>
              {view.chainValid ? `Hash chain verified: ${view.entries.length} records intact` : `Chain broken at record #${broken}: ${view.reason}`}
            </div>
            <div className="mt-0.5 break-all font-mono text-[11px] text-muted">
              {view.chainValid
                ? <>head {view.head ?? '(empty log)'} </>
                : <>Record #{broken} and the {view.entries.length - broken - 1} after it can no longer be trusted. The file on disk was changed after it was written.</>}
            </div>
            {checkedAt && <div className="mt-0.5 text-[11px] text-slate-500">Verified against the file at {new Date(checkedAt).toLocaleTimeString([], { hour12: false })} · {view.file}</div>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button tone="cyan" onClick={load}>Verify hash chain</Button>
            {view.chainValid
              ? <Button tone="amber" disabled={!view.entries.length} title="Edits one record in the file on disk, the way an attacker covering their tracks would" onClick={() => act('/api/audit/tamper')}>Simulate tamper</Button>
              : <Button tone="green" title="Rewrites the file from the server's in-memory chain" onClick={() => act('/api/audit/restore')}>Restore file</Button>}
          </div>
        </div>
      )}
      {view?.quarantined && (
        <p className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          At start-up the previous log failed verification at record #{view.quarantined.brokenAt} ({view.quarantined.reason}). It was set aside as <span className="font-mono">{view.quarantined.file}</span> and a new chain was started.
        </p>
      )}

      <Panel title="Records" right={
        <div className="flex items-center gap-2">
          <input aria-label="Search records" className={cx(inputCls, '!w-48 !py-1 !text-xs')} placeholder="Search tool, reason, hash…" value={q} onChange={e => setQ(e.target.value)} />
          <select aria-label="Filter by action" className={cx(inputCls, '!w-auto !py-1 !text-xs')} value={kind} onChange={e => setKind(e.target.value)}>
            {kinds.map(k => <option key={k}>{k}</option>)}
          </select>
        </div>
      }>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-xs">
            <thead className="border-b border-line text-[10.5px] uppercase tracking-wider text-muted">
              <tr>{['#', 'Time', 'Action', 'Tool', 'Decision', 'Detail', 'Hash', 'Prev'].map(h => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody className="font-mono">
              {rows.map(({ e, i }) => {
                const bad = broken >= 0 && i === broken;
                const after = broken >= 0 && i > broken;
                return (
                  <tr key={i} className={cx('border-b border-line/60 align-top', bad ? 'bg-rose-500/15' : after ? 'opacity-55' : 'hover:bg-raised/50')}>
                    <td className="px-3 py-2 text-muted">{i}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted">{e.at ? new Date(e.at).toLocaleTimeString([], { hour12: false }) : '—'}</td>
                    <td className="px-3 py-2">{e.kind ?? 'unparseable'}{bad && <Badge tone="red" className="ml-2">ALTERED</Badge>}{after && <Badge className="ml-2">unverified</Badge>}</td>
                    <td className="px-3 py-2 text-text">{typeof e.data?.tool === 'string' ? e.data.tool : '—'}</td>
                    <td className="px-3 py-2">{decision(e)}</td>
                    <td className="max-w-[340px] px-3 py-2 font-sans text-muted"><span className="line-clamp-2" dir="auto">{detail(e)}</span></td>
                    <td className="px-3 py-2 text-cyan-300/80" title={e.hash}>{short(e.hash)}</td>
                    <td className="px-3 py-2 text-slate-500" title={e.prev}>{short(e.prev)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && <p className="px-4 py-12 text-center text-sm text-muted">{view?.entries.length ? 'No records match.' : 'The log is empty. Run a scenario on the Live page.'}</p>}
        </div>
      </Panel>
    </>
  );
}
