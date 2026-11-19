import { canonical } from 'admiralty-gate';

export const EMBED_DIM = 256;

/**
 * Feature-hashed character-trigram vector, L2-normalised. This is a LEXICAL embedding: it places texts with similar
 * spelling near each other (robust to word order, inflection and small edits) and knows nothing about meaning.
 * It needs no model and no network. To get semantic search, pass a real embedding function of the same dimension
 * as `embed` in the app options.
 */
export function hashEmbedding(text: string, dim = EMBED_DIM): number[] {
  const v = new Array<number>(dim).fill(0);
  const s = ` ${canonical(text)} `;
  for (let i = 0; i + 3 <= s.length; i++) {
    // FNV-1a over the trigram's code units.
    let h = 0x811c9dc5;
    for (let j = i; j < i + 3; j++) {
      h ^= s.charCodeAt(j);
      h = Math.imul(h, 0x01000193);
    }
    const idx = (h >>> 0) % dim;
    v[idx]! += (h >>> 31) === 0 ? 1 : -1;
  }
  const norm = Math.hypot(...v);
  return norm ? v.map(x => x / norm) : v;
}

export const cosine = (a: readonly number[], b: readonly number[]): number => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);
