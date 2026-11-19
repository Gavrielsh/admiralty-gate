import { STATUS, type IncidentStatus } from '@/lib/api';

/** Shape carries the status as well as colour, the same way the map draws it: filled disc, hollow circle, disc with a halo. */
export function StatusMark({ status, size = 12 }: { status: IncidentStatus; size?: number }) {
  const c = STATUS[status].color;
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden className="shrink-0">
      {status === 'released' && <circle cx="6" cy="6" r="5" fill={c} />}
      {status === 'quarantined' && <circle cx="6" cy="6" r="4" fill="none" stroke={c} strokeWidth="2" />}
      {status === 'ring' && <><circle cx="6" cy="6" r="5.5" fill={c} opacity="0.3" /><circle cx="6" cy="6" r="3" fill={c} /></>}
    </svg>
  );
}

export function StatusLabel({ status }: { status: IncidentStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-text">
      <StatusMark status={status} />
      {STATUS[status].label}
    </span>
  );
}
