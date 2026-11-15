import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { loadEnvFile } from './env.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
// API keys live in .env.local at the repository root (or in apps/server). They are read here and nowhere else.
for (const f of [join(repoRoot, '.env.local'), resolve(here, '../.env.local')]) loadEnvFile(f);

const port = Number(process.env.PORT ?? 4319);
// Loopback only by default: this API can approve tool calls and has no login.
const host = process.env.HOST ?? '127.0.0.1';
const dataDir = process.env.ADMIRALTY_DATA_DIR ?? resolve(here, '../data');
const webOrigins = (process.env.WEB_ORIGIN ?? 'http://localhost:3000,http://127.0.0.1:3000').split(',').map(s => s.trim()).filter(Boolean);

const { fastify } = await buildApp({ dataDir, webOrigins });
await fastify.listen({ port, host });
console.log(`[admiralty-gate] API on http://${host}:${port}  data: ${dataDir}`);
console.log(`[admiralty-gate] providers: anthropic=${process.env.ANTHROPIC_API_KEY ? 'key set' : 'no key'} openai=${process.env.OPENAI_API_KEY ? 'key set' : 'no key'}`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void fastify.close().then(() => process.exit(0)));
