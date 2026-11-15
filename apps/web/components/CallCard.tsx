import type { ArgProvenance, CallRecord } from '@/lib/api';
import { Badge, cx, gateTone, provTone, time } from './ui';

const STATUS: Record<CallRecord['status'], { label: string; tone: 'gray' | 'green' | 'red' | 'amber' }> = {
  intercepted: { label: 'intercepted', tone: 'gray' },
  awaiting_approval: { label: 'paused: waiting for a human', tone: 'amber' },
  executed: { label: 'executed', tone: 'green' },
  blocked: { label: 'not executed', tone: 'red' },
};
const HOST = { authorised: ['green', 'host authorised'], 'not-authorised': ['red', 'host not in authorised list'], 'not-a-single-host': ['red', 'not a single host'] } as const;
const SOURCE = { sandbox: 'sandbox', 'mcp-proxy': 'MCP proxy', 'mcp-bridge': 'MCP bridge' } as const;

const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

export function ArgList({ args, provenance }: { args: Record<string, unknown>; provenance: ArgProvenance[] }) {
  const keys = Object.keys(args);
  if (!keys.length) return <p className="font-mono text-xs text-slate-600">no arguments</p>;
  return (
    <dl className="space-y-1">
      {keys.map(k => {
        const p = provenance.find(x => x.arg === k);
        return (
          <div key={k} className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs">
            <dt className="text-muted">{k}</dt>
            <dd className="max-w-full break-all rounded bg-canvas px-1.5 py-0.5 text-text" dir="auto">{show(args[k])}</dd>
            {p ? (
              <Badge tone={provTone(p.label)} title={p.origins.length ? `seen in: ${p.origins.join(', ')}` : undefined}>
                {p.label}{p.origins.length ? ` · ${p.origins.join(', ')}` : ''}
              </Badge>
            ) : (
              <Badge title="This argument is not a declared target, so the gate did not trace it">not traced</Badge>
            )}
          </div>
        );
      })}
    </dl>
  );
}

export function CallCard({ call }: { call: CallRecord }) {
  const st = STATUS[call.status];
  const edge = call.gate === 'ALLOW' ? 'border-l-emerald-500' : call.gate === 'BLOCK' ? 'border-l-rose-500' : call.gate === 'ELICIT' ? 'border-l-amber-500' : 'border-l-slate-600';
  return (
    <li className={cx('arrive rounded-md border border-l-[3px] border-line bg-raised/60 p-3', edge)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] text-slate-500">{time(call.at)}</span>
        <span className="font-mono text-sm font-semibold text-text">{call.tool}</span>
        {call.tier && <Badge>{call.tier}</Badge>}
        <Badge>{SOURCE[call.source]}</Badge>
        <span className="ml-auto flex items-center gap-1.5">
          <Badge tone={st.tone}>{st.label}</Badge>
          <Badge tone={gateTone(call.gate)} className="!px-2 !py-1 !text-xs !font-bold">{call.gate ?? '…'}</Badge>
        </span>
      </div>
      <div className="mt-2.5">
        <ArgList args={call.args} provenance={call.provenance} />
      </div>
      {call.hostChecks.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {call.hostChecks.map((h, i) => (
            <Badge key={i} tone={HOST[h.result][0]}>{HOST[h.result][1]}: {h.value}</Badge>
          ))}
        </div>
      )}
      {call.reasons.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-muted">
          {call.reasons.map((r, i) => <li key={i} dir="auto">— {r}</li>)}
        </ul>
      )}
      {call.approval && call.approval.state !== 'pending' && (
        <p className="mt-2 text-xs">
          <span className="text-muted">Human decision: </span>
          <span className={call.approval.state === 'approved' ? 'text-emerald-300' : 'text-rose-300'}>{call.approval.state}</span>
        </p>
      )}
    </li>
  );
}
