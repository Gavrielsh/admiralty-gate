/**
 * Text normalisation and hostile-text telemetry.
 *
 * IMPORTANT: nothing in this file is the security boundary. Pattern
 * detection of injection phrases is a heuristic that attackers can always
 * evade; the boundary is the structural gate in guard.ts. These functions
 * exist so that (1) provenance matching sees the same text a model would
 * read, and (2) analysts get telemetry about suspicious content.
 */

/** Zero-width and invisible formatting characters used to split or hide tokens. */
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;
/** Unicode "tag" characters (U+E0000 block): a known way to smuggle invisible ASCII. */
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;
/** Bidirectional controls: override/embedding/isolates, relevant for Hebrew/Arabic/Persian text. */
const BIDI = /[‪-‮⁦-⁩‎‏؜]/g;

const NON_ASCII = /[^\x00-\x7f]/;

export type TextFlag =
  | 'invisible-chars'
  | 'bidi-controls'
  | 'unicode-tag-smuggling'
  | 'instruction-like'
  | 'tool-call-like'
  | 'role-spoof';

/** Multilingual, intentionally broad, imperative-instruction cues. Telemetry only. */
const INSTRUCTION_CUES: readonly RegExp[] = [
  /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|earlier|all)\b.{0,30}\b(instruction|prompt|rule)s?\b/i,
  /\b(you must|you are now|new instructions?|system prompt|developer message)\b/i,
  /\b(run|execute|call|invoke|use)\b.{0,25}\b(recon|tool|scan|lookup|portscan|shodan|whois)\b/i,
  // Hebrew
  /(התעלם|התעלמי).{0,30}(הוראות|ההנחיות)/u,
  /(הרץ|בצע|הפעל).{0,25}(סריקה|כלי|חיפוש)/u,
  // Arabic
  /(تجاهل).{0,30}(التعليمات|الأوامر)/u,
  /(نفّذ|نفذ|شغّل|شغل).{0,25}(أداة|فحص|مسح)/u,
  // Persian
  /(نادیده\s*بگیر).{0,30}(دستور|دستورات)/u,
  /(اجرا\s*کن).{0,25}(ابزار|اسکن)/u,
  // Russian
  /(игнорируй|забудь).{0,30}(предыдущ|инструкц)/iu,
  /(выполни|запусти).{0,25}(инструмент|скан|поиск)/iu,
];

const TOOL_CALL_LIKE = /("tool"\s*:\s*"|\btool_call\b|<\s*tool\b|\bfunction_call\b)/i;
const ROLE_SPOOF = /(^|\n)\s*(system|assistant|developer)\s*[:：]/i;

export interface Sanitised {
  /** Text with invisible/bidi characters removed, tag-character payloads decoded to ASCII, and NFKC-normalised. */
  clean: string;
  flags: TextFlag[];
}

export function sanitiseUntrusted(raw: string): Sanitised {
  const flags = new Set<TextFlag>();
  if (TAG_CHARS.test(raw)) flags.add('unicode-tag-smuggling');
  TAG_CHARS.lastIndex = 0;
  if (BIDI.test(raw)) flags.add('bidi-controls');
  BIDI.lastIndex = 0;
  if (INVISIBLE.test(raw)) flags.add('invisible-chars');
  INVISIBLE.lastIndex = 0;

  // Tag characters are DECODED, not dropped: a model that reads them sees the hidden ASCII, so provenance must too.
  const decoded = raw.replace(TAG_CHARS, ch => {
    const cp = ch.codePointAt(0)!;
    return cp >= 0xe0020 && cp <= 0xe007e ? String.fromCharCode(cp - 0xe0000) : '';
  });
  const clean = decoded.replace(INVISIBLE, '').normalize('NFKC');
  if (INSTRUCTION_CUES.some(re => re.test(clean))) flags.add('instruction-like');
  if (TOOL_CALL_LIKE.test(clean)) flags.add('tool-call-like');
  if (ROLE_SPOOF.test(clean)) flags.add('role-spoof');
  return { clean, flags: [...flags] };
}

/**
 * Canonical form for matching: sanitised, lower-cased, combining marks
 * (Arabic harakat, Hebrew niqqud, Latin accents) removed, whitespace collapsed.
 */
export function canonical(raw: string): string {
  // Plain ASCII has no invisible characters, tag characters or combining marks, and normalisation leaves it alone.
  if (!NON_ASCII.test(raw)) return raw.toLowerCase().replace(/\s+/g, ' ').trim();
  return sanitiseUntrusted(raw)
    .clean.normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word tokens over any script. Trailing sentence punctuation is not part of a token. */
export function tokens(raw: string): string[] {
  const found = canonical(raw).match(/[\p{L}\p{N}][\p{L}\p{N}_.@:/?#=&%+~-]*/gu) ?? [];
  return found.map(t => t.replace(/[.:/?#=&%+~_-]+$/u, '')).filter(Boolean);
}

/** Hostnames of any URL-shaped tokens, so "example.com" traces to "https://example.com/a". */
export function hostsOf(toks: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of toks) {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/:?#]+)/u.exec(t);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

/** Is `needle` a contiguous run of whole tokens inside `hay`? */
export function containsRun(hay: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** k-word shingles for near-duplicate detection. */
export function shingles(raw: string, k = 5): Set<string> {
  const t = tokens(raw);
  const out = new Set<string>();
  if (t.length === 0) return out;
  if (t.length <= k) {
    out.add(t.join(' '));
    return out;
  }
  for (let i = 0; i + k <= t.length; i++) out.add(t.slice(i, i + k).join(' '));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Wrap untrusted text in a per-session random fence so it cannot forge its
 * own closing delimiter. Spotlighting reduces accidental obedience but, as the
 * literature shows, only modestly; it is defence in depth, not the boundary.
 */
export function fenceUntrusted(text: string, label: string, nonce: string): string {
  const safe = sanitiseUntrusted(text).clean.split(nonce).join('[redacted]');
  return `<<UNTRUSTED ${nonce} source="${label.replace(/"/g, "'")}">>\n${safe}\n<<END ${nonce}>>`;
}
