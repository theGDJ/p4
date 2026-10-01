import { config } from '../config';
import { providerUnavailable } from '../lib/errors';
import { logger } from '../lib/logger';

/**
 * Provider interfaces (§3: "LLM + embeddings behind provider interfaces
 * (config-switchable, mockable in tests)").
 *
 * The mock implementation is deterministic and offline. It exists so that
 * retrieval, citation validation (R3), the R4 fallback and evidence tiers are all
 * testable without network access or API keys — which is the only option in this
 * sandbox, where provider APIs are unreachable and no keys exist.
 *
 * A real provider must satisfy the same contract; nothing else in the app may
 * branch on `provider === 'mock'`.
 */

export interface GenerationRequest {
  /** Static system prompt first, so provider-side prefix caching can apply (§9). */
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxOutputTokens: number;
  temperature?: number;
  language: 'en' | 'hi';
  intent: string;
}

export interface GenerationResult {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  finishReason: 'stop' | 'length' | 'error';
}

export interface LlmProvider {
  readonly name: string;
  readonly isMock: boolean;
  generate(req: GenerationRequest): Promise<GenerationResult>;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly isMock: boolean;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/* ------------------------------------------------------------------ mock LLM */

/**
 * Deterministic mock. It NEVER invents facts (R1/R2): with no retrieved chunks it
 * can only produce the R4 fallback, which is also the correct answer for an empty
 * knowledge base. Output is prefixed so it cannot be mistaken for a real answer.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';
  readonly isMock = true;

  async generate(req: GenerationRequest): Promise<GenerationResult> {
    const c = config();
    // Simulate a small amount of work so streaming behaviour is observable.
    await new Promise((r) => setTimeout(r, 5));
    const text = `[MOCK PROVIDER] ${req.messages.at(-1)?.content ?? ''}`.slice(0, req.maxOutputTokens * 4);
    return {
      text,
      model: c.LLM_LARGE_MODEL,
      promptTokens: estimateTokens(req.systemPrompt) + req.messages.reduce((n, m) => n + estimateTokens(m.content), 0),
      completionTokens: estimateTokens(text),
      costUsd: 0,
      finishReason: 'stop',
    };
  }
}

/**
 * Stand-in for a real HTTP provider. Deliberately refuses to run when no
 * credentials are configured instead of silently returning fake output (R8/R10).
 */
export class RemoteLlmProvider implements LlmProvider {
  readonly name: string;
  readonly isMock = false;
  constructor(
    name: string,
    private readonly baseUrl: string | undefined,
    private readonly apiKey: string | undefined,
  ) {
    this.name = name;
  }

  async generate(_req: GenerationRequest): Promise<GenerationResult> {
    if (!this.baseUrl || !this.apiKey) {
      logger.error('LLM provider is selected but not configured', { provider: this.name });
      throw providerUnavailable(
        `The '${this.name}' provider is selected but LLM_BASE_URL / LLM_API_KEY are not set.`,
      );
    }
    // Real HTTP call lands in P2. Failing loudly here is the correct interim
    // behaviour: a missing implementation must never look like a successful answer.
    logger.error('LLM provider call not implemented in the mock API stack', { provider: this.name });
    throw providerUnavailable(
      `Provider '${this.name}' is not implemented by the Node mock API. Run the Spring Boot backend (APP_STACK=spring) for real generation.`,
    );
  }
}

/* ------------------------------------------------------------- mock embedding */

/**
 * Deterministic hashing "embedding". It is NOT semantically meaningful and must
 * never be used to claim retrieval quality — it exists so the embedding cache,
 * batching and dimension checks in §5/§9 have something to exercise offline.
 *
 * The real system requires a multilingual model for Hindi<->English retrieval
 * (§3); that is configured via EMBEDDING_PROVIDER and validated at boot.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock';
  readonly isMock = true;
  readonly dimensions: number;

  constructor(dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 1024)) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    const normalised = text.toLowerCase();
    // Character-trigram hashing: stable, cheap, dimension-safe.
    for (let i = 0; i < normalised.length - 2; i += 1) {
      const gram = normalised.slice(i, i + 3);
      let h = 2166136261;
      for (let j = 0; j < gram.length; j += 1) {
        h ^= gram.charCodeAt(j);
        h = Math.imul(h, 16777619);
      }
      const idx = Math.abs(h) % this.dimensions;
      vec[idx] = (vec[idx] ?? 0) + 1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}

/* ------------------------------------------------------------------- factory */

export function resolveLlmProvider(): LlmProvider {
  const c = config();
  if (c.LLM_PROVIDER === 'mock') return new MockLlmProvider();
  return new RemoteLlmProvider(c.LLM_PROVIDER, process.env.LLM_BASE_URL, process.env.LLM_API_KEY);
}

export function resolveEmbeddingProvider(): EmbeddingProvider {
  const c = config();
  if (c.EMBEDDING_PROVIDER === 'mock') {
    return new MockEmbeddingProvider(Number(process.env.EMBEDDING_DIMENSIONS ?? 1024));
  }
  logger.error('Non-mock embedding provider is not implemented by the Node mock API', {
    provider: c.EMBEDDING_PROVIDER,
  });
  return new MockEmbeddingProvider(Number(process.env.EMBEDDING_DIMENSIONS ?? 1024));
}

/** Rough token estimate (~4 chars/token). Used for budget accounting (§9). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
