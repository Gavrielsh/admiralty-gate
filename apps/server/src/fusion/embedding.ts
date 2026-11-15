/**
 * Embedding providers. The server owns embeddings; the core only ever receives the resulting scores.
 *
 *   local  (default)  @huggingface/transformers, ONNX, a multilingual model, runs offline after the first download
 *   http              any OpenAI-compatible /embeddings endpoint
 *   mock              deterministic lexical hashing: for tests, and the fallback when the local model cannot load
 */
import { hashEmbedding } from './embed.js';

export type EmbedKind = 'query' | 'passage';

export interface EmbeddingProvider {
  readonly name: string;
  /** Vector length. Known after `init()`. */
  dim: number;
  /** True for a provider that understands meaning; false for the lexical mock. */
  readonly semantic: boolean;
  init(): Promise<void>;
  embed(texts: readonly string[], kind?: EmbedKind): Promise<number[][]>;
}

const normalise = (v: number[]): number[] => {
  const n = Math.hypot(...v);
  return n ? v.map(x => x / n) : v;
};

export class MockEmbedding implements EmbeddingProvider {
  readonly name: string;
  readonly semantic = false;
  constructor(public dim = 256, name = 'mock (lexical hash)') {
    this.name = name;
  }
  async init(): Promise<void> {}
  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map(t => hashEmbedding(t, this.dim));
  }
}

/** OpenAI-compatible: POST {url} {"model", "input": [...]} -> {"data": [{"embedding": [...]}]} */
export class HttpEmbedding implements EmbeddingProvider {
  readonly semantic = true;
  dim = 0;
  readonly name: string;
  constructor(private readonly url: string, private readonly model: string, private readonly apiKey: string | undefined, private readonly fetchFn: typeof fetch = fetch, private readonly batch = 64) {
    this.name = `http (${model})`;
  }
  async init(): Promise<void> {
    this.dim = (await this.embed(['dimension probe']))[0]!.length;
  }
  async embed(texts: readonly string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batch) {
      const res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.model, input: texts.slice(i, i + this.batch) }),
      });
      if (!res.ok) throw new Error(`embedding endpoint returned HTTP ${res.status}`);
      const body = (await res.json()) as { data?: { embedding?: unknown; index?: number }[] };
      const rows = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (rows.length !== Math.min(this.batch, texts.length - i)) throw new Error('embedding endpoint returned a different number of vectors than inputs');
      for (const r of rows) {
        if (!Array.isArray(r.embedding) || r.embedding.some(x => typeof x !== 'number')) throw new Error('embedding endpoint returned a malformed vector');
        if (this.dim && r.embedding.length !== this.dim) throw new Error(`embedding endpoint changed dimension (${r.embedding.length} instead of ${this.dim})`);
        out.push(normalise(r.embedding as number[]));
      }
    }
    return out;
  }
}

/** Local multilingual model through transformers.js. E5 models expect "query: " / "passage: " prefixes. */
export class LocalEmbedding implements EmbeddingProvider {
  readonly semantic = true;
  dim = 0;
  readonly name: string;
  private extractor: ((texts: string[], o: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>) | undefined;
  constructor(private readonly model: string, private readonly cacheDir?: string) {
    this.name = `local (${model})`;
  }
  async init(): Promise<void> {
    const t = await import('@huggingface/transformers');
    if (this.cacheDir) t.env.cacheDir = this.cacheDir;
    this.extractor = (await t.pipeline('feature-extraction', this.model, { dtype: 'q8' })) as never;
    this.dim = (await this.embed(['dimension probe']))[0]!.length;
  }
  async embed(texts: readonly string[], kind: EmbedKind = 'passage'): Promise<number[][]> {
    if (!this.extractor) throw new Error('embedding model is not loaded');
    const e5 = /e5/i.test(this.model);
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16).map(t => (e5 ? `${kind}: ${t}` : t));
      out.push(...(await this.extractor(batch, { pooling: 'mean', normalize: true })).tolist());
    }
    return out;
  }
}

export interface EmbeddingChoice {
  provider: EmbeddingProvider;
  /** Set when the configured provider could not be used and the lexical mock stands in. */
  degraded?: string;
}

/**
 * EMBEDDING_PROVIDER = local (default) | http | mock. A provider that fails to initialise does not stop the server:
 * the lexical mock takes over and the reason is reported at start-up and in /api/fusion/status.
 */
export async function chooseEmbedding(env: Record<string, string | undefined>, fetchFn: typeof fetch = fetch): Promise<EmbeddingChoice> {
  const which = (env.EMBEDDING_PROVIDER ?? 'local').toLowerCase();
  if (which === 'mock') return { provider: new MockEmbedding() };
  let provider: EmbeddingProvider;
  if (which === 'http') {
    if (!env.EMBEDDING_API_URL) return { provider: new MockEmbedding(), degraded: 'EMBEDDING_PROVIDER=http but EMBEDDING_API_URL is not set' };
    provider = new HttpEmbedding(env.EMBEDDING_API_URL, env.EMBEDDING_MODEL ?? 'text-embedding-3-small', env.EMBEDDING_API_KEY, fetchFn);
  } else if (which === 'local') provider = new LocalEmbedding(env.EMBEDDING_MODEL ?? 'Xenova/multilingual-e5-small', env.EMBEDDING_CACHE_DIR);
  else return { provider: new MockEmbedding(), degraded: `unknown EMBEDDING_PROVIDER "${which}"` };
  try {
    await provider.init();
    return { provider };
  } catch (e) {
    return { provider: new MockEmbedding(), degraded: `${provider.name} could not be loaded: ${(e as Error).message.slice(0, 200)}` };
  }
}
