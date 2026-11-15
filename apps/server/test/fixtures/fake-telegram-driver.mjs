// Stand-in for the GramJS driver: serves messages from the JSON file named in FAKE_TG_FILE.
import { readFileSync } from 'node:fs';
export async function fetchMessages(channel, afterId, limit) {
  const all = JSON.parse(readFileSync(process.env.FAKE_TG_FILE, 'utf8'))[channel];
  if (!all) throw new Error(`no such channel ${channel}`);
  return all.filter(m => m.id > afterId).slice(0, limit).map(m => ({
    text: m.text, externalId: String(m.id), at: m.at,
    owner: `tg:${(m.forwardedFrom ?? channel).toLowerCase()}`,
    meta: { channel, messageId: m.id, ...(m.forwardedFrom ? { forwardedFrom: m.forwardedFrom } : {}) },
  }));
}
