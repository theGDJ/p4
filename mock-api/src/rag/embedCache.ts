import { createHash } from 'node:crypto';
import { logger } from '../lib/logger';
import { resolveEmbeddingProvider, type EmbeddingProvider } from './providers';

/**
 * Embedding cache by content hash (§9: "Embedding cache by content hash;
 * re-embed only changed chunks").
 *
 * The key is `model:sha256(text)` — the model name is part of it because an
 * embedding from another model is not comparable in the same vector space, and
 * silently reusing one would be the quiet version of a wrong answer.
 *
 * Process-local and bounded. The production system puts the same structure in
 * Redis (see `docs/ARCHITECTURE.md` §7); the in-memory version here is not a
 * claim that a shared cache exists.
 */

export interface EmbeddingResult {
  vectors: number[][];
  cacheHits: number;
  /** How many chunks actually went over the wire (or through the mock). */
  embedded: number;
  model: string;
  dimensions: number;
}

interface Entry {
  vector: number[];
  model: string;
  embeddedAt: string;
  hits: number;
}

const MAX_ENTRIES = 5000;
let cache = new Map<string, Entry>();
let misses = 0;
let enabled = true;

/** Test seam: turn the cache off to measure raw provider call volume. */
export function setEmbeddingCacheEnabled(next: boolean): void {
  enabled = next;
  if (!next) cache = new Map();
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function resetEmbeddingCache(): void {
  cache = new Map();
}

export function embeddingCacheStats(): { entries: number; hits: number; misses: number } {
  let hits = 0;
  for (const e of cache.values()) hits += e.hits;
  return { entries: cache.size, hits, misses };
}

/**
 * Embeds only the texts that are not already cached, in one batched provider call
 * set. A cache entry whose model differs from the active provider's is treated as a
 * miss, which is what makes a model swap re-embed instead of mixing vector spaces.
 */
export async function embedTexts(texts: string[], provider?: EmbeddingProvider): Promise<EmbeddingResult> {
  const active = provider ?? resolveEmbeddingProvider();
  const model = active.describe().model;
  const vectors: (number[] | undefined)[] = new Array(texts.length).fill(undefined);
  let cacheHits = 0;

  // One provider slot per distinct text: a document that repeats a line (a running
  // header, a table caption) must not pay for it twice inside the same call. The
  // duplicate counts as a hit because the point of the counter is "how many provider
  // calls did we not make".
  const pending: { indices: number[]; text: string; key: string }[] = [];
  const pendingSlot = new Map<string, number>();
  texts.forEach((text, index) => {
    const key = `${model}:${contentHash(text)}`;
    const hit = cache.get(key);
    if (hit && hit.model === model && hit.vector.length === active.dimensions) {
      hit.hits += 1;
      vectors[index] = hit.vector;
      cacheHits += 1;
      return;
    }
    if (hit) cache.delete(key); // stale model or width — never serve it
    const slot = pendingSlot.get(key);
    if (slot !== undefined) {
      pending[slot]!.indices.push(index);
      cacheHits += 1;
      return;
    }
    misses += 1;
    pendingSlot.set(key, pending.length);
    pending.push({ indices: [index], text, key });
  });

  if (pending.length > 0) {
    const fresh = await active.embed(pending.map((p) => p.text));
    if (fresh.length !== pending.length) {
      // A short batch would otherwise be stored as null and read back later.
      throw new Error(
        `The embedding provider returned ${fresh.length} vector(s) for ${pending.length} request(s); nothing was cached.`,
      );
    }
    const now = new Date().toISOString();
    pending.forEach((p, i) => {
      const vector = fresh[i]!;
      if (vector.length !== active.dimensions) {
        throw new Error(
          `Embedding width ${vector.length} does not match the configured ${active.dimensions}; the chunk was not stored.`,
        );
      }
      for (const index of p.indices) vectors[index] = vector;
      putEntry(p.key, { vector, model, embeddedAt: now, hits: 0 });
    });
    logger.debug('embedded chunks', { count: pending.length, model, of: texts.length });
  }

  return {
    vectors: vectors.map((v) => v ?? null).filter((v): v is number[] => v !== null),
    cacheHits,
    embedded: pending.length,
    model,
    dimensions: active.dimensions,
  };
}

function putEntry(key: string, entry: Entry): void {
  if (!enabled) return;
  cache.set(key, entry);
  if (cache.size > MAX_ENTRIES) {
    // Insertion order is the eviction order (Map semantics): the oldest entries go.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
}
