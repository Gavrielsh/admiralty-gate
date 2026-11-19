'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useGate } from '@/lib/events';
import { useState } from 'react';
import { API, getApiKey, setApiKey } from '@/lib/api';
import { cx } from './ui';

const NAV = [
  { href: '/', label: 'Live interceptor', hint: 'Tool calls, approvals, playground' },
  { href: '/fusion', label: 'Fusion map', hint: 'Incidents, rings, heatmap' },
  { href: '/corroboration', label: 'Corroboration', hint: 'Raw sources vs independent origins' },
  { href: '/ach', label: 'ACH matrix', hint: 'Competing hypotheses' },
  { href: '/grounding', label: 'Grounding inspector', hint: 'Which sources back each sentence' },
  { href: '/audit', label: 'Audit log', hint: 'Hash-chained, tamper-evident' },
  { href: '/policy', label: 'Policy editor', hint: 'Strict JSON policy' },
];

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { connected, approvals, authRequired } = useGate();
  const [key, setKey] = useState('');
  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <aside className="shrink-0 border-b border-line bg-panel lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M12 2.5 4 5.5v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10v-6l-8-3Z" stroke="#22d3ee" strokeWidth="1.5" />
            <path d="M8.5 12h7M12 8.5v7" stroke="#22d3ee" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <div>
            <div className="text-sm font-semibold tracking-wide">admiralty-gate</div>
            <div className="text-[10.5px] uppercase tracking-[0.16em] text-muted">operations console</div>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-col lg:overflow-visible">
          {NAV.map(n => {
            const active = n.href === '/' ? path === '/' : path.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined}
                className={cx('min-w-max rounded-md border px-3 py-2 transition-colors lg:min-w-0', active ? 'border-cyan-500/40 bg-cyan-500/10' : 'border-transparent hover:bg-raised')}>
                <div className={cx('flex items-center gap-2 text-[13px] font-medium', active ? 'text-cyan-200' : 'text-text')}>
                  {n.label}
                  {n.href === '/' && approvals.length > 0 && (
                    <span className="rounded-full bg-amber-500 px-1.5 text-[10px] font-bold text-black">{approvals.length}</span>
                  )}
                </div>
                <div className="hidden text-[11px] text-muted lg:block">{n.hint}</div>
              </Link>
            );
          })}
        </nav>
        <div className="hidden px-4 py-3 text-[11px] text-muted lg:absolute lg:bottom-0 lg:block">
          <div className="flex items-center gap-2">
            <span className={cx('h-2 w-2 rounded-full', connected ? 'bg-emerald-400' : 'bg-rose-500')} />
            {connected ? 'Live stream connected' : 'Stream disconnected'}
          </div>
          <div className="mt-1 font-mono text-[10px] text-slate-600">{API}</div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 lg:p-6">
        {authRequired && (
          <form className="mb-4 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-3 text-xs text-amber-100" onSubmit={e => { e.preventDefault(); setApiKey(key.trim()); setKey(''); }}>
            <p className="mb-2"><b>This server requires an API key.</b> Enter the value of <span className="font-mono">ADMIRALTY_API_KEY</span>{getApiKey() ? ' (the one in this tab was refused)' : ''}. It is kept for this browser tab only.</p>
            <div className="flex max-w-xl gap-2">
              <input type="password" autoComplete="off" aria-label="API key" value={key} onChange={e => setKey(e.target.value)} className="w-full rounded-md border border-line bg-canvas px-2.5 py-1.5 font-mono text-[13px] text-text" placeholder="API key" />
              <button type="submit" disabled={!key.trim()} className="rounded-md border border-amber-500/60 bg-amber-500/20 px-3 py-1.5 font-medium disabled:opacity-40">Connect</button>
            </div>
          </form>
        )}
        {!connected && !authRequired && (
          <p role="status" className="mb-4 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            Not connected to the gate server at <span className="font-mono">{API}</span>. Start it with <span className="font-mono">npm run dev</span>; this page reconnects by itself.
          </p>
        )}
        {children}
      </main>
    </div>
  );
}
