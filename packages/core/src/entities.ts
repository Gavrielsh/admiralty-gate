/**
 * Hard-indicator extraction: deterministic, regex-based, no network.
 *
 * An indicator is something two items can share only for a reason: the same
 * IP, wallet, device fingerprint, Telegram channel. Sharing one is evidence
 * of a common operator, which is what independence clustering needs.
 *
 * Two different uses, kept apart on purpose:
 *  - indicators that describe WHO PRODUCED an item (the session's IP, the
 *    wallet paid, the forwarding channel) are supplied structurally by the
 *    caller as `Item.indicators`;
 *  - indicators merely MENTIONED in an item's text are what `extractEntities`
 *    finds. Ten outlets reporting on the same IP all mention it and are not
 *    thereby one source, so clustering only uses text mentions on request.
 */
import { sanitiseUntrusted } from './text.js';

export type IndicatorKind =
  | 'ip' | 'cidr' | 'asn' | 'wallet' | 'txhash' | 'domain' | 'phone' | 'telegram' | 'handle' | 'email'
  /** Structural only (never extracted from prose): device or session fingerprint, platform account id. */
  | 'device' | 'account';

export interface Indicator {
  kind: IndicatorKind;
  /** Normalised value: lower-cased where the identifier is case-insensitive. */
  value: string;
}

export const indicatorKey = (i: Indicator): string => `${i.kind}:${i.value}`;

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const RE = {
  ip: new RegExp(`(?<![\\w.])(${OCTET}(?:\\.${OCTET}){3})(\\/(?:3[0-2]|[12]?\\d))?(?![\\w]|\\.\\d)`, 'g'),
  asn: /(?<![\w])AS(\d{1,10})(?![\w])/gi,
  txhash: /(?<![\w])(?:0x)?([a-fA-F0-9]{64})(?![\w])/g,
  eth: /(?<![\w])0x([a-fA-F0-9]{40})(?![\w])/g,
  btcBech32: /(?<![\w])(bc1[ac-hj-np-z02-9]{11,71})(?![\w])/gi,
  btcBase58: /(?<![\w])([13][a-km-zA-HJ-NP-Z1-9]{25,34})(?![\w])/g,
  email: /(?<![\w.+-])([a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?![\w])/gi,
  telegram: /(?:t|telegram)\.me\/(?:s\/)?([a-z][a-z0-9_]{3,31})(?![\w])/gi,
  handle: /(?<![\w@.\/])@([a-z][a-z0-9_]{3,31})(?![\w@]|\.[a-z])/gi,
  phone: /(?<![\w+])\+\d[\d\s().-]{6,20}\d(?![\w])/g,
  domain: /(?<![\w@.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?![\w-])/gi,
};

/** Normalise a structurally supplied indicator the same way extraction does. */
export function normaliseIndicator(kind: IndicatorKind, value: string): Indicator {
  const v = sanitiseUntrusted(String(value)).clean.trim();
  switch (kind) {
    case 'asn':
      return { kind, value: `as${v.replace(/^as/i, '')}` };
    case 'phone':
      return { kind, value: `+${v.replace(/\D/g, '')}` };
    case 'wallet':
      // Base58 is case-sensitive; hex and bech32 are not.
      return { kind, value: /^(0x|bc1)/i.test(v) ? v.toLowerCase() : v };
    case 'telegram':
    case 'handle':
      return { kind, value: v.replace(/^@/, '').toLowerCase() };
    default:
      return { kind, value: v.toLowerCase() };
  }
}

/** Indicators mentioned in free text, de-duplicated, in first-seen order. */
export function extractEntities(raw: string): Indicator[] {
  const text = sanitiseUntrusted(raw).clean;
  const out = new Map<string, Indicator>();
  const add = (kind: IndicatorKind, value: string) => {
    const i = normaliseIndicator(kind, value);
    out.set(indicatorKey(i), i);
  };
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) fn(m);
  };

  each(RE.ip, m => add(m[2] ? 'cidr' : 'ip', m[1]! + (m[2] ?? '')));
  each(RE.asn, m => add('asn', m[1]!));
  each(RE.txhash, m => add('txhash', m[1]!));
  each(RE.eth, m => add('wallet', `0x${m[1]!}`));
  each(RE.btcBech32, m => add('wallet', m[1]!));
  each(RE.btcBase58, m => add('wallet', m[1]!));
  each(RE.email, m => add('email', m[1]!));
  each(RE.telegram, m => add('telegram', m[1]!));
  each(RE.handle, m => add('handle', m[1]!));
  each(RE.phone, m => {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 15) add('phone', digits);
  });
  each(RE.domain, m => {
    const d = m[1]!.toLowerCase();
    // t.me links are reported as telegram indicators, not as the shared domain "t.me".
    if (d !== 't.me' && d !== 'telegram.me') add('domain', d);
  });
  return [...out.values()];
}
