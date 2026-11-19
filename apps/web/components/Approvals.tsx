'use client';

import { useEffect, useState } from 'react';
import { api, type PendingApproval } from '@/lib/api';
import { useGate } from '@/lib/events';
import { ArgList } from './CallCard';
import { Badge, Button, ErrorNote } from './ui';

function Card({ a }: { a: PendingApproval }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [left, setLeft] = useState(() => Math.max(0, Math.round((a.expiresAt - Date.now()) / 1000)));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Math.round((a.expiresAt - Date.now()) / 1000))), 1000);
    return () => clearInterval(t);
  }, [a.expiresAt]);
  const answer = async (approve: boolean) => {
    setBusy(true);
    setErr('');
    try {
      await api(`/api/approvals/${a.id}`, { method: 'POST', body: { approve } });
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <li className="attention rounded-md border border-amber-500/60 bg-amber-500/[0.07] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-300">Paused tool call</span>
        <span className="font-mono text-sm font-semibold">{a.tool}</span>
        {a.tier && <Badge>{a.tier}</Badge>}
        <span className="ml-auto font-mono text-[11px] text-muted" title="No answer counts as a denial">auto-deny in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>
      </div>
      <div className="mt-2"><ArgList args={a.args} provenance={a.provenance} /></div>
      <ul className="mt-2 space-y-0.5 text-xs text-amber-100/80">
        {a.reasons.map((r, i) => <li key={i} dir="auto">— {r}</li>)}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button tone="green" disabled={busy} onClick={() => answer(true)}>Approve and run</Button>
        <Button tone="red" disabled={busy} onClick={() => answer(false)}>Deny</Button>
        <span className="text-[11px] text-muted">Approve only if you asked for this action.</span>
      </div>
      {err && <div className="mt-2"><ErrorNote>{err}</ErrorNote></div>}
    </li>
  );
}

export function Approvals() {
  const { approvals } = useGate();
  if (!approvals.length) return null;
  return (
    <section aria-label="Pending approvals" className="mb-4">
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-300">
        {approvals.length} tool call{approvals.length > 1 ? 's' : ''} waiting for your decision
      </h2>
      <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">{approvals.map(a => <Card key={a.id} a={a} />)}</ul>
    </section>
  );
}
