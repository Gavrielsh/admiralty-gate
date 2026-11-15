/**
 * Tamper-evident audit log: each record commits to the previous one with
 * SHA-256, so any edit, deletion or reordering breaks verification from that
 * point on. Records are plain JSON, safe to ship to append-only storage.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

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

  /**
   * @param sink called with every appended record, e.g. to write it to append-only storage as it happens.
   * @param resumeFrom records of an earlier run to continue the chain from (they are verified first).
   */
  constructor(
    private readonly clock: () => number = () => Date.now(),
    private readonly sink?: (rec: AuditRecord) => void,
    resumeFrom: readonly AuditRecord[] = [],
  ) {
    if (resumeFrom.length) {
      const v = AuditLog.verify(resumeFrom);
      if (!v.ok) throw new Error(`Refusing to extend a broken audit chain: ${v.reason} at record ${v.at}`);
      this._records.push(...resumeFrom);
    }
  }

  /**
   * A log persisted to a JSONL file: existing records are verified and the chain continues after them; each new
   * record is appended synchronously, so a crash loses at most the record being written.
   */
  static file(path: string, clock: () => number = () => Date.now()): AuditLog {
    const prior = existsSync(path) ? AuditLog.fromJsonl(readFileSync(path, 'utf8')) : [];
    return new AuditLog(clock, rec => appendFileSync(path, JSON.stringify(rec) + '\n'), prior);
  }

  /** Hash of the newest record. Publishing or countersigning it elsewhere makes truncation of the tail detectable. */
  head(): string {
    return this._records.length ? this._records[this._records.length - 1]!.hash : GENESIS;
  }

  append(kind: string, data: unknown): AuditRecord {
    const prev = this._records.length ? this._records[this._records.length - 1]!.hash : GENESIS;
    const base = { seq: this._records.length, at: this.clock(), kind, data: JSON.parse(stable(data)) as unknown, prev };
    const rec: AuditRecord = { ...base, hash: hashRecord(base) };
    this.sink?.(rec);
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
