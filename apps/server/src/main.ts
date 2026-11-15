import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { loadEnvFile } from './env.js';
import { PgStore } from './fusion/pgstore.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
// API keys live in .env.local at the repository root (or in apps/server). They are read here and nowhere else.
for (const f of [join(repoRoot, '.env.local'), resolve(here, '../.env.local')]) loadEnvFile(f);

const port = Number(process.env.PORT ?? 4319);
// Loopback only by default: this API can approve tool calls and has no login.
const host = process.env.HOST ?? '127.0.0.1';
const dataDir = process.env.ADMIRALTY_DATA_DIR ?? resolve(here, '../data');
const webOrigins = (process.env.WEB_ORIGIN ?? 'http://localhost:3000,http://127.0.0.1:3000').split(',').map(s => s.trim()).filter(Boolean);

// DATABASE_URL -> PostgreSQL (PostGIS + pgvector); REDIS_URL -> BullMQ. Without them: in-memory store, in-process queue.
const store = process.env.DATABASE_URL ? new PgStore(process.env.DATABASE_URL) : undefined;
const app = await buildApp({ dataDir, webOrigins, host, ...(store ? { store } : {}), ...(process.env.REDIS_URL ? { redisUrl: process.env.REDIS_URL } : {}) });
const { fastify } = app;
await fastify.listen({ port, host });
console.log(`[admiralty-gate] API on http://${host}:${port}  data: ${dataDir}`);
console.log(`[admiralty-gate] store: ${store ? 'postgres (PostGIS + pgvector)' : 'memory'}  queue: ${process.env.REDIS_URL ? 'bullmq (redis)' : 'in-process'}`);
const st = (await fastify.inject({ url: '/api/fusion/status', headers: process.env.ADMIRALTY_API_KEY ? { 'x-api-key': process.env.ADMIRALTY_API_KEY } : {} })).json() as { embedding: { provider: string; dim: number; degraded?: string }; geoip: { sources: string[]; notes: string[] }; gazetteer: { sources: string[]; notes: string[] } };
console.log(`[admiralty-gate] embedding: ${st.embedding.provider} (${st.embedding.dim} dims)${st.embedding.degraded ? `  DEGRADED: ${st.embedding.degraded}` : ''}`);
console.log(`[admiralty-gate] geoip: ${st.geoip.sources.join(', ') || 'none'}  gazetteer: ${st.gazetteer.sources.join(', ')}`);
for (const n of [...st.geoip.notes, ...st.gazetteer.notes]) console.log(`[admiralty-gate] note: ${n}`);
console.log(`[admiralty-gate] auth: ${process.env.ADMIRALTY_API_KEY ? 'API key required' : 'none (loopback only)'}  telegram: ${app.telegram ? 'live collector on' : 'off'}`);
console.log(`[admiralty-gate] providers: anthropic=${process.env.ANTHROPIC_API_KEY ? 'key set' : 'no key'} openai=${process.env.OPENAI_API_KEY ? 'key set' : 'no key'}`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void fastify.close().then(() => process.exit(0)));
