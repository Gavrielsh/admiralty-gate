/**
 * Provenance ledger: every piece of text that enters an agent's context is
 * recorded with where it came from and whether it is trusted to carry
 * instructions. Tool-call arguments are later traced back to these spans.
 *
 * Trust model (deliberately two-valued and conservative):
 *  - "trusted"   : typed by the authenticated operator in this session.
 *  - "untrusted" : everything else (feeds, web, Telegram, tool results, files).
 *
 * Untrusted data may INFORM an analysis, but it can never AUTHORISE an
 * action. Authorisation always traces to a trusted span or an explicit
 * human approval.
 */
import type { Grade } from './grades.js';
import { canonical, containsRun, hostsOf, sanitiseUntrusted, tokens, type TextFlag } from './text.js';

export type OriginKind = 'user' | 'feed' | 'web' | 'telegram' | 'sensor' | 'tool' | 'model' | 'file';

export interface Origin {
  /** Stable id of the publisher/channel/sensor (used for independence). */
  id: string;
  kind: OriginKind;
  /** Optional Admiralty grade of this origin; undefined for the operator. */
  grade?: Grade;
  /** Canonical owner/network, so two domains of one outlet count as one origin. */
  owner?: string;
  url?: string;
}

export interface Span {
  id: string;
  text: string;
  canonicalText: string;
  tokens: readonly string[];
  hosts: ReadonlySet<string>;
  origin: Origin;
  trusted: boolean;
  flags: TextFlag[];
  at: number;
}

export type TraceClass =
  /** The value appears in a trusted operator span. */
  | 'trusted'
  /** The value appears only in untrusted spans. */
  | 'tainted'
  /** The value appears in no recorded span (model-derived, transformed, or invented). */
  | 'unknown';

export interface Trace {
  class: TraceClass;
  trustedSpans: string[];
  untrustedSpans: string[];
  /** Origins of the untrusted spans the value appears in. */
  origins: Origin[];
}

export class ProvenanceLedger {
  private readonly _spans: Span[] = [];
  private seq = 0;

  constructor(private readonly clock: () => number = () => Date.now()) {}

  /** Record text typed by the authenticated operator. */
  addTrusted(text: string, origin: Partial<Origin> = {}): Span {
    return this.push(text, { id: origin.id ?? 'operator', kind: 'user', ...origin }, true);
  }

  /** Record anything that is not the operator: feeds, web pages, posts, tool output. */
  addUntrusted(text: string, origin: Origin): Span {
    if (origin.kind === 'user') throw new Error('Untrusted spans cannot claim origin kind "user".');
    return this.push(text, origin, false);
  }

  private push(text: string, origin: Origin, trusted: boolean): Span {
    const { flags } = sanitiseUntrusted(text);
    const toks = tokens(text);
    const span: Span = {
      id: `s${++this.seq}`,
      text,
      canonicalText: canonical(text),
      tokens: toks,
      hosts: new Set(hostsOf(toks)),
      origin,
      trusted,
      flags,
      at: this.clock(),
    };
    this._spans.push(span);
    return span;
  }

  spans(): readonly Span[] {
    return this._spans;
  }

  /**
   * Where does this argument value come from? A value is traced by WHOLE-TOKEN
   * match (a contiguous run of tokens), after the same normalisation a model
   * effectively applies when reading: invisible characters, case and
   * diacritics do not hide it. Whole-token matching matters: a substring match
   * would let the value "ample.com" borrow trust from an operator who typed
   * "example.com".
   *
   * Policy for mixed provenance: if the value appears in ANY trusted span it
   * is "trusted" (the operator said it). Appearing additionally in untrusted
   * text does not change that, because the operator independently supplied it.
   */
  trace(value: unknown): Trace {
    const v = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
    const need = tokens(v);
    const empty: Trace = { class: 'unknown', trustedSpans: [], untrustedSpans: [], origins: [] };
    if (need.length === 0) return empty;
    const trusted: string[] = [];
    const untrusted: string[] = [];
    const origins = new Map<string, Origin>();
    for (const s of this._spans) {
      const hit = containsRun(s.tokens, need) || (need.length === 1 && s.hosts.has(need[0]!));
      if (!hit) continue;
      if (s.trusted) trusted.push(s.id);
      else {
        untrusted.push(s.id);
        origins.set(`${s.origin.kind}:${s.origin.id}`, s.origin);
      }
    }
    const cls: TraceClass = trusted.length ? 'trusted' : untrusted.length ? 'tainted' : 'unknown';
    return { class: cls, trustedSpans: trusted, untrustedSpans: untrusted, origins: [...origins.values()] };
  }
}
