/**
 * Tamper-evident audit log: each record commits to the previous one with
 * SHA-256, so any edit, deletion or reordering breaks verification from that
 * point on. Records are plain JSON, safe to ship to append-only storage.
 */
import { createHash } from 'node:crypto';

export interface AuditRecord {
  seq: number;
  at: number;
  kind: string;
  data: unknown;
  prev: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map(k => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(',')}}`;
}

export function hashRecord(r: Omit<AuditRecord, 'hash'>): string {
  return createHash('sha256').update(`${r.seq}|${r.at}|${r.kind}|${stable(r.data)}|${r.prev}`).digest('hex');
}

export class AuditLog {
  private readonly _records: AuditRecord[] = [];

  constructor(private readonly clock: () => number = () => Date.now()) {}

  append(kind: string, data: unknown): AuditRecord {
    const prev = this._records.length ? this._records[this._records.length - 1]!.hash : GENESIS;
    const base = { seq: this._records.length, at: this.clock(), kind, data: JSON.parse(stable(data)) as unknown, prev };
    const rec: AuditRecord = { ...base, hash: hashRecord(base) };
    this._records.push(rec);
    return rec;
  }

  records(): readonly AuditRecord[] {
    return this._records;
  }

  toJsonl(): string {
    return this._records.map(r => JSON.stringify(r)).join('\n') + (this._records.length ? '\n' : '');
  }

  static verify(records: readonly AuditRecord[]): { ok: true } | { ok: false; at: number; reason: string } {
    let prev = GENESIS;
    for (let i = 0; i < records.length; i++) {
      const r = records[i]!;
      if (r.seq !== i) return { ok: false, at: i, reason: 'sequence gap or reorder' };
      if (r.prev !== prev) return { ok: false, at: i, reason: 'broken chain link' };
      const { hash, ...rest } = r;
      if (hashRecord(rest) !== hash) return { ok: false, at: i, reason: 'record content altered' };
      prev = hash;
    }
    return { ok: true };
  }

  static fromJsonl(s: string): AuditRecord[] {
    return s
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as AuditRecord);
  }
}
