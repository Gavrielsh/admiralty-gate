/**
 * Telegram driver on GramJS (MTProto). It reads public channels the logged-in account can see; it never posts.
 * Credentials come from the environment (.env.local): TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION.
 * Create the session string once with `npm run telegram:login -w @admiralty-gate/server`.
 */
import type { CollectedItem } from './parse.js';

interface TgMessage {
  id: number;
  message?: string;
  date?: number;
  fwdFrom?: { fromName?: string; fromId?: unknown };
}
interface TgClient {
  connect(): Promise<unknown>;
  checkAuthorization(): Promise<boolean>;
  getMessages(entity: string, o: { limit: number; minId: number }): Promise<TgMessage[]>;
  getEntity(id: unknown): Promise<{ title?: string; username?: string; firstName?: string }>;
}

let client: Promise<TgClient> | undefined;

function connect(): Promise<TgClient> {
  client ??= (async () => {
    const apiId = Number(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH;
    const session = process.env.TELEGRAM_SESSION;
    if (!apiId || !apiHash || !session) throw new Error('TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_SESSION must be set in .env.local');
    const { TelegramClient } = await import('telegram');
    const { StringSession } = await import('telegram/sessions/index.js');
    const c = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 5 }) as unknown as TgClient;
    await c.connect();
    if (!(await c.checkAuthorization())) throw new Error('TELEGRAM_SESSION is not authorised; create a new one with the login script');
    return c;
  })();
  return client;
}

/** Messages of `channel` with id greater than `afterId`, oldest first. */
export async function fetchMessages(channel: string, afterId: number, limit: number): Promise<CollectedItem[]> {
  const c = await connect();
  const msgs = await c.getMessages(channel, { limit, minId: afterId });
  const out: CollectedItem[] = [];
  for (const m of [...msgs].sort((a, b) => a.id - b.id)) {
    const text = (m.message ?? '').trim();
    if (!text) continue;
    let forwardedFrom = m.fwdFrom?.fromName;
    if (!forwardedFrom && m.fwdFrom?.fromId) {
      try {
        const e = await c.getEntity(m.fwdFrom.fromId);
        forwardedFrom = e.username ?? e.title ?? e.firstName;
      } catch {
        /* the origin is hidden or no longer resolvable */
      }
    }
    out.push({
      text,
      externalId: String(m.id),
      owner: `tg:${(forwardedFrom ?? channel).replace(/^@/, '').trim().toLowerCase()}`,
      ...(m.date ? { at: m.date * 1000 } : {}),
      meta: { channel, messageId: m.id, ...(forwardedFrom ? { forwardedFrom } : {}) },
    });
  }
  return out;
}
