/** Pure parsers for collector inputs. They produce raw items; grading and ingestion happen in the server. */
export interface CollectedItem {
  text: string;
  externalId?: string;
  at?: number;
  owner?: string;
  claim?: string;
  stance?: 'supports' | 'contradicts';
  geo?: { lat: number; lon: number };
  claimedPlace?: string;
  indicators?: { kind: string; value: string }[];
  meta?: Record<string, unknown>;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
/** Text content of an XML/HTML fragment: CDATA unwrapped, tags dropped, entities decoded once. */
const plain = (s: string): string =>
  decode(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const tag = (xml: string, name: string): string | undefined => new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml)?.[1];

/** RSS 2.0 `<item>` and Atom `<entry>` elements. Tolerant by design: a malformed item is skipped, not fatal. */
export function parseFeed(xml: string): CollectedItem[] {
  const out: CollectedItem[] = [];
  for (const m of xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)) {
    const body = m[2]!;
    const title = plain(tag(body, 'title') ?? '');
    const desc = plain(tag(body, 'description') ?? tag(body, 'summary') ?? tag(body, 'content') ?? tag(body, 'content:encoded') ?? '');
    const text = [title, desc].filter(Boolean).join('. ');
    if (!text) continue;
    const link = plain(tag(body, 'link') ?? '') || /<link[^>]*href="([^"]+)"/i.exec(body)?.[1];
    const id = plain(tag(body, 'guid') ?? tag(body, 'id') ?? '') || link;
    const when = Date.parse(plain(tag(body, 'pubDate') ?? tag(body, 'published') ?? tag(body, 'updated') ?? tag(body, 'dc:date') ?? ''));
    out.push({ text, ...(id ? { externalId: id } : {}), ...(Number.isFinite(when) ? { at: when } : {}), ...(link ? { meta: { link } } : {}) });
  }
  return out;
}

interface TgMessage {
  id?: number;
  type?: string;
  date?: string;
  date_unixtime?: string;
  from?: string;
  forwarded_from?: string;
  text?: string | (string | { type?: string; text?: string })[];
}

/**
 * A Telegram Desktop chat export (`result.json`). Reading an export keeps collection offline and under the
 * operator's control. A forwarded message is attributed to the channel it was forwarded FROM (as `owner`), which is
 * what lets independence clustering see ten channels forwarding one post as one origin.
 */
export function parseTelegramExport(json: string): CollectedItem[] {
  const doc = JSON.parse(json) as { name?: string; id?: number; messages?: TgMessage[] };
  const channel = doc.name ?? String(doc.id ?? 'telegram');
  const out: CollectedItem[] = [];
  for (const msg of doc.messages ?? []) {
    if (msg.type && msg.type !== 'message') continue;
    const text = (typeof msg.text === 'string' ? msg.text : (msg.text ?? []).map(p => (typeof p === 'string' ? p : (p.text ?? ''))).join('')).trim();
    if (!text) continue;
    const at = msg.date_unixtime ? Number(msg.date_unixtime) * 1000 : msg.date ? Date.parse(msg.date) : NaN;
    out.push({
      text,
      owner: `tg:${(msg.forwarded_from ?? channel).trim().toLowerCase()}`,
      ...(msg.id !== undefined ? { externalId: String(msg.id) } : {}),
      ...(Number.isFinite(at) ? { at } : {}),
      meta: { channel, ...(msg.forwarded_from ? { forwardedFrom: msg.forwarded_from } : {}) },
    });
  }
  return out;
}

/** One JSON object per line (tool or CLI output). A line needs a "text" (or "summary"/"title") string. */
export function parseJsonl(text: string): CollectedItem[] {
  const out: CollectedItem[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const t = [o.text, o.summary, o.title].find((x): x is string => typeof x === 'string' && x.trim().length > 0);
    if (!t) continue;
    const at = typeof o.at === 'number' ? o.at : typeof o.at === 'string' ? Date.parse(o.at) : typeof o.ts === 'number' ? o.ts : NaN;
    const lat = typeof o.lat === 'number' ? o.lat : undefined;
    const lon = typeof o.lon === 'number' ? o.lon : typeof o.lng === 'number' ? o.lng : undefined;
    out.push({
      text: t,
      ...(typeof o.id === 'string' || typeof o.id === 'number' ? { externalId: String(o.id) } : {}),
      ...(Number.isFinite(at) ? { at } : {}),
      ...(typeof o.claim === 'string' ? { claim: o.claim } : {}),
      ...(o.stance === 'supports' || o.stance === 'contradicts' ? { stance: o.stance } : {}),
      ...(typeof o.place === 'string' ? { claimedPlace: o.place } : {}),
      ...(lat !== undefined && lon !== undefined ? { geo: { lat, lon } } : {}),
    });
  }
  return out;
}
