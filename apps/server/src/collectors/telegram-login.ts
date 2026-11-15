#!/usr/bin/env node
/**
 * One-time interactive login that prints a TELEGRAM_SESSION string for .env.local.
 * Needs TELEGRAM_API_ID and TELEGRAM_API_HASH (from my.telegram.org) in the environment.
 * The session string grants access to the account: keep it out of version control.
 */
import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../env.js';

const here = dirname(fileURLToPath(import.meta.url));
loadEnvFile(join(resolve(here, '../../../..'), '.env.local'));
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
if (!apiId || !apiHash) {
  console.error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env.local first.');
  process.exit(1);
}
const rl = createInterface({ input: process.stdin, output: process.stderr });
const { TelegramClient } = await import('telegram');
const { StringSession } = await import('telegram/sessions/index.js');
const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
await client.start({
  phoneNumber: () => rl.question('Phone number (international format): '),
  password: () => rl.question('Two-step verification password (empty if none): '),
  phoneCode: () => rl.question('Code Telegram just sent you: '),
  onError: e => console.error(e.message),
});
console.error('\nAdd this line to .env.local:\n');
console.log(`TELEGRAM_SESSION=${String(client.session.save())}`);
rl.close();
await client.disconnect();
process.exit(0);
