'use client';

import { useMemo, useState } from 'react';
import { Approvals } from '@/components/Approvals';
import { CallCard } from '@/components/CallCard';
import { Playground } from '@/components/Playground';
import { Panel, cx } from '@/components/ui';
import type { GateOutcome } from '@/lib/api';
import { useGate } from '@/lib/events';

const FILTERS: ('ALL' | GateOutcome)[] = ['ALL', 'ALLOW', 'BLOCK', 'ELICIT'];
const TINT: Record<string, string> = { ALLOW: 'text-emerald-300', BLOCK: 'text-rose-300', ELICIT: 'text-amber-300', ALL: 'text-text' };

export default function LivePage() {
  const { calls } = useGate();
  const [filter, setFilter] = useState<'ALL' | GateOutcome>('ALL');
  const counts = useMemo(() => {
    const c = { ALL: calls.length, ALLOW: 0, BLOCK: 0, ELICIT: 0 };
    for (const x of calls) if (x.gate) c[x.gate]++;
    return c;
  }, [calls]);
  const shown = filter === 'ALL' ? calls : calls.filter(c => c.gate === filter);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Live interceptor</h1>
          <p className="text-xs text-muted">Every tool call the gate sees, where each argument came from, and what the gate decided.</p>
        </div>
        <div className="flex gap-2" role="group" aria-label="Filter by gate decision">
          {FILTERS.map(f => (
            <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
              className={cx('min-w-[72px] rounded-md border px-3 py-1.5 text-left transition-colors', filter === f ? 'border-cyan-500/50 bg-cyan-500/10' : 'border-line bg-panel hover:border-slate-500')}>
              <div className={cx('font-mono text-base font-semibold leading-none', TINT[f])}>{counts[f]}</div>
              <div className="mt-1 text-[10px] uppercase tracking-wider text-muted">{f === 'ALL' ? 'calls' : f}</div>
            </button>
          ))}
        </div>
      </div>

      <Approvals />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <Panel title="Intercepted tool calls" right={<span className="text-[11px] text-muted">newest first</span>}>
          {shown.length === 0 ? (
            <div className="px-4 py-14 text-center text-sm text-muted">
              {calls.length === 0 ? 'No tool calls yet. Run a scenario in the playground to watch the gate react.' : `No ${filter} decisions yet.`}
            </div>
          ) : (
            <ul className="space-y-2 p-3">{shown.map(c => <CallCard key={c.id} call={c} />)}</ul>
          )}
        </Panel>
        <div className="xl:sticky xl:top-6 xl:self-start"><Playground /></div>
      </div>
    </>
  );
}
