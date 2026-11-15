import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { GateOutcome, ProvenanceLabel } from '@/lib/api';

export const cx = (...a: (string | false | null | undefined)[]): string => a.filter(Boolean).join(' ');

export function Panel({ title, right, children, className }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-lg border border-line bg-panel', className)}>
      {(title || right) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{title}</h2>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

const TONES = {
  green: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  red: 'border-rose-500/50 bg-rose-500/10 text-rose-300',
  amber: 'border-amber-500/50 bg-amber-500/10 text-amber-300',
  cyan: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300',
  gray: 'border-line bg-raised text-muted',
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone = 'gray', children, title, className }: { tone?: Tone; children: ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[10.5px] font-medium leading-none', TONES[tone], className)}>
      {children}
    </span>
  );
}

export const gateTone = (g?: GateOutcome): Tone => (g === 'ALLOW' ? 'green' : g === 'BLOCK' ? 'red' : g === 'ELICIT' ? 'amber' : 'gray');
export const provTone = (l: ProvenanceLabel): Tone => (l === 'OPERATOR' ? 'green' : l === 'UNKNOWN' ? 'amber' : 'red');

export function Button({ tone = 'gray', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'gray' | 'green' | 'red' | 'cyan' | 'amber' }) {
  const tones = {
    gray: 'border-line bg-raised text-text hover:border-slate-500',
    green: 'border-emerald-500/60 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25',
    red: 'border-rose-500/60 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25',
    cyan: 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25',
    amber: 'border-amber-500/60 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25',
  };
  return <button {...p} className={cx('rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40', tones[tone], className)} />;
}

export const inputCls = 'w-full rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[13px] text-text placeholder:text-slate-600';
export const time = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour12: false });
export const short = (h?: string, n = 10): string => (h ? `${h.slice(0, n)}…` : '');

export function ErrorNote({ children }: { children: ReactNode }) {
  return <p role="alert" className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{children}</p>;
}
