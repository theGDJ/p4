import { config, type AppConfig } from '../config';
import { providerUnavailable } from '../lib/errors';
import { logger } from '../lib/logger';

/**
 * Provider interfaces (§3: "LLM + embeddings behind provider interfaces
 * (config-switchable, mockable in tests)").
 *
 * P2 status — what is real and what is not, stated plainly:
 *
 *   `openai-compatible` is a real HTTP client. It speaks the
 *   `/chat/completions` and `/embeddings` shapes used by OpenAI, vLLM, Ollama,
 *   Azure's compatibility endpoint and Google's `/v1beta/openai`, so a deployment
 *   needs only `LLM_BASE_URL` + `LLM_API_KEY`. It is exercised end-to-end by the
 *   test suite against a local stand-in server, which is what makes the whole
 *   answer pipeline (retrieval → generate → R3 validation → tier) testable
 *   offline. It has **not** been called against a vendor from this sandbox:
 *   api.openai.com and generativelanguage.googleapis.com are unreachable here
 *   (docs/ENVIRONMENT.md), so the wire format is verified against the local
 *   stand-in only, and the vendor call itself is unproven from this machine.
 *
 *   `mock` is deterministic and offline. It exists so citation validation (R3),
 *   the R4 fallback and evidence tiers have a non-network path to be tested on.
 *
 * Nothing else in the app may branch on `provider === 'mock'` except the badge
 * and the readiness probe, both of which read `isMock`.
 */

export type ModelSize = 'small' | 'large';

export interface GenerationRequest {
  /** Static system prompt first, so provider-side prefix caching can apply (§9). */
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxOutputTokens: number;
  temperature?: number;
  language: 'en' | 'hi';
  intent: string;
  /** §9: routing/rewrite/follow-ups use the small model; answers and reports use the large one. */
  model?: ModelSize;
  signal?: AbortSignal;
}

export interface GenerationResult {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /**
   * `null` when no pricing is configured. An invented dollar figure in a cost
   * budget is exactly the fabricated number §11/R10 forbids, so absence is
   * reported as absence.
   */
  costUsd: number | null;
  /** True when the provider sent no `usage` block and the counts are estimated. */
  usageEstimated: boolean;
  finishReason: 'stop' | 'length' | 'error';
}

export interface LlmProvider {
  readonly name: string;
  readonly isMock: boolean;
  generate(req: GenerationRequest): Promise<GenerationResult>;
  /** For `/health/ready` and `/meta/bootstrap`; must never contain the API key. */
  describe(): ProviderDescription;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly isMock: boolean;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  describe(): ProviderDescription;
}

export interface ProviderDescription {
  name: string;
  isMock: boolean;
  configured: boolean;
  baseUrl: string | null;
  model: string;
  /** Only for the embedding provider; null for the LLM. */
  dimensions: number | null;
  detail: string;
}

/* --------------------------------------------------------------- HTTP core */

interface HttpTarget {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
}

class ProviderHttpError extends Error {
  constructor(
    readonly kind: 'auth' | 'rate-limit' | 'server' | 'network' | 'timeout' | 'bad-response',
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One POST, with bounded retries for the retryable classes only.
 *
 * Retry rules: 429 and 5xx are retried with exponential backoff (honouring
 * `Retry-After`); 400/404/422 are never retried, because a malformed request will
 * still be malformed the third time; `Retry-After` is clamped so a hostile or
 * misconfigured gateway cannot park a request indefinitely.
 */
async function postJson(
  target: HttpTarget,
  path: string,
  body: unknown,
  callerSignal?: AbortSignal,
): Promise<unknown> {
  const url = `${target.baseUrl}${path}`;
  let lastError: ProviderHttpError | null = null;

  for (let attempt = 0; attempt <= target.maxRetries; attempt += 1) {
    // A per-attempt timeout, plus the caller's own cancellation (an SSE client that
    // hung up should not leave a provider call running).
    const signal = combineSignals(AbortSignal.timeout(target.timeoutMs), callerSignal);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${target.apiKey}`,
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        // The provider's error body may echo the request (which contains retrieved
        // document text). It is never forwarded to the client; only its status and
        // a sanitised one-liner reach the log.
        const detail = await safeErrorDetail(response);
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        const kind =
          response.status === 401 || response.status === 403
            ? 'auth'
            : response.status === 429
              ? 'rate-limit'
              : response.status >= 500
                ? 'server'
                : 'bad-response';
        const err = new ProviderHttpError(
          kind,
          `provider responded ${response.status}${detail ? ` (${detail})` : ''}`,
          retryAfterMs,
        );
        if (kind === 'auth' || kind === 'bad-response') throw err;
        lastError = err;
        if (attempt < target.maxRetries) {
          await sleep(Math.min(backoffMs(attempt, retryAfterMs), 8_000));
          continue;
        }
        throw err;
      }

      const json: unknown = await response.json();
      if (json === null || typeof json !== 'object') {
        throw new ProviderHttpError('bad-response', 'provider returned a non-object body');
      }
      return json;
    } catch (err) {
      if (err instanceof ProviderHttpError) {
        if (err.kind === 'auth' || err.kind === 'bad-response') throw err;
        lastError = err;
      } else {
        // `AbortSignal.timeout()` rejects with a DOMException named TimeoutError;
        // anything else that looks like an abort is the caller hanging up.
        const reason = signal.reason as { name?: string } | undefined;
        const timedOut = reason?.name === 'TimeoutError';
        const cancelled = callerSignal?.aborted === true;
        if (cancelled) throw new ProviderHttpError('network', 'request cancelled by the client');
        lastError = new ProviderHttpError(
          timedOut ? 'timeout' : 'network',
          timedOut ? 'provider request timed out' : 'provider unreachable',
        );
        logger.warn('provider request failed', { kind: lastError.kind, attempt, path });
      }
      if (attempt < target.maxRetries) {
        await sleep(Math.min(backoffMs(attempt, lastError.retryAfterMs), 8_000));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new ProviderHttpError('network', 'provider unreachable');
}

/** Timeout ∪ caller cancellation, with a manual race for runtimes without `AbortSignal.any`. */
function combineSignals(timeoutSignal: AbortSignal, caller: AbortSignal | undefined): AbortSignal {
  if (!caller) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([timeoutSignal, caller]);
  const controller = new AbortController();
  for (const source of [timeoutSignal, caller]) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    source.addEventListener('abort', () => controller.abort(source.reason), { once: true });
  }
  return controller.signal;
}

async function safeErrorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).slice(0, 240);
    // Strip anything URL- or key-shaped before it reaches a log line. The dash is
    // last in the class so it is unambiguously literal, not a range.
    return text
      .replace(/https?:\/\/\S+/g, '[url]')
      .replace(/[A-Za-z0-9_-]{20,}/g, '[redacted]')
      .slice(0, 120);
  } catch {
    return '';
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 30) * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.min((date - Date.now()) / 1000, 30) * 1000);
  return null;
}

function backoffMs(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return retryAfterMs;
  return 250 * 2 ** attempt + Math.floor(Math.random() * 120);
}

function requireTarget(kind: 'llm' | 'embedding', c: AppConfig): HttpTarget {
  const baseUrl = kind === 'llm' ? c.LLM_BASE_URL : (c.EMBEDDING_BASE_URL ?? c.LLM_BASE_URL);
  const apiKey = kind === 'llm' ? c.LLM_API_KEY : (c.EMBEDDING_API_KEY ?? c.LLM_API_KEY);
  if (!baseUrl || !apiKey) {
    // config.ts already refuses to boot in this state; this check exists so the
    // failure stays correct even if a caller injects a hand-made config (tests).
    throw providerUnavailable(
      `The ${kind} provider is set to openai-compatible but its base URL or API key is missing.`,
    );
  }
  return {
    baseUrl,
    apiKey,
    timeoutMs: kind === 'llm' ? c.LLM_TIMEOUT_MS : c.EMBEDDING_TIMEOUT_MS,
    maxRetries: kind === 'llm' ? c.LLM_MAX_RETRIES : c.EMBEDDING_MAX_RETRIES,
  };
}

function maskUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return 'invalid-url';
  }
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
      model: req.model === 'small' ? c.LLM_SMALL_MODEL : c.LLM_LARGE_MODEL,
      promptTokens:
        estimateTokens(req.systemPrompt) +
        req.messages.reduce((n, m) => n + estimateTokens(m.content), 0),
      completionTokens: estimateTokens(text),
      costUsd: 0,
      usageEstimated: true,
      finishReason: 'stop',
    };
  }

  describe(): ProviderDescription {
    const c = config();
    return {
      name: 'mock',
      isMock: true,
      configured: true,
      baseUrl: null,
      model: c.LLM_LARGE_MODEL,
      dimensions: null,
      detail: 'deterministic offline provider — no grounded answers can be generated',
    };
  }
}

/* ------------------------------------------------- OpenAI-compatible real LLM */

/**
 * Chat-completions client.
 *
 * Deliberately buffered: the whole completion is validated against R3 before a
 * single token is written to the SSE stream, so provider-side streaming would buy
 * nothing (docs/ARCHITECTURE.md §5). The client→browser hop *is* streamed.
 */
export class OpenAiCompatibleLlmProvider implements LlmProvider {
  readonly name = 'openai-compatible';
  readonly isMock = false;

  async generate(req: GenerationRequest): Promise<GenerationResult> {
    const c = config();
    const target = requireTarget('llm', c);
    const model = req.model === 'small' ? c.LLM_SMALL_MODEL : c.LLM_LARGE_MODEL;

    const payload = {
      model,
      messages: [
        // Static system prompt first so provider prefix caching can hit it (§9).
        { role: 'system', content: req.systemPrompt },
        ...req.messages,
      ],
      max_tokens: req.maxOutputTokens,
      // §10 forbids creative variation; a temperature other than 0 would make the
      // R4 exact-sentence invariant flaky.
      temperature: req.temperature ?? 0,
    };

    let json: unknown;
    try {
      json = await postJson(target, '/chat/completions', payload, req.signal);
    } catch (err) {
      const kind = err instanceof ProviderHttpError ? err.kind : 'network';
      logger.error('generation failed at the provider', { kind, model });
      throw providerUnavailable(
        kind === 'auth'
          ? 'The model provider rejected its credentials. An administrator must fix the server configuration.'
          : 'The model provider is not responding. Your question was not answered; nothing was invented in its place.',
      );
    }

    const parsed = parseChatCompletion(json, model);
    const completionTokens = parsed.completionTokens ?? estimateTokens(parsed.text);
    const promptTokens = parsed.promptTokens ?? estimateTokens(req.systemPrompt) + req.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
    const costUsd = estimateCostUsd(promptTokens, completionTokens);

    return {
      text: parsed.text,
      model: parsed.model ?? model,
      promptTokens,
      completionTokens,
      costUsd,
      usageEstimated: parsed.usageEstimated,
      finishReason: parsed.finishReason,
    };
  }

  describe(): ProviderDescription {
    const c = config();
    return {
      name: 'openai-compatible',
      isMock: false,
      configured: c.llmConfigured,
      baseUrl: maskUrl(c.LLM_BASE_URL),
      model: c.LLM_LARGE_MODEL,
      dimensions: null,
      detail: `chat completions via ${maskUrl(c.LLM_BASE_URL) ?? 'unconfigured base URL'}; small=${c.LLM_SMALL_MODEL}`,
    };
  }
}

interface ParsedChatCompletion {
  text: string;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  usageEstimated: boolean;
  finishReason: 'stop' | 'length' | 'error';
}

/**
 * Tolerant of the `content`-vs-`content_parts` and null-usage variations across
 * gateways, but intolerant of an answer that is not there: an empty completion is
 * an error, never an empty assistant message that looks like a real answer (R8).
 */
export function parseChatCompletion(json: unknown, requestedModel: string): ParsedChatCompletion {
  const root = (json ?? {}) as Record<string, unknown>;
  const choices = root.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw providerUnavailable('The model provider returned no completion.');
  }
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (first.message ?? first.delta ?? {}) as Record<string, unknown>;
  const rawContent = message.content;

  let text = '';
  if (typeof rawContent === 'string') {
    text = rawContent;
  } else if (Array.isArray(rawContent)) {
    // Some gateways return content as a list of typed parts.
    text = rawContent
      .map((part) => {
        const p = (part ?? {}) as Record<string, unknown>;
        return typeof p.text === 'string' ? p.text : '';
      })
      .join('');
  }

  if (text.trim().length === 0) {
    throw providerUnavailable('The model provider returned an empty completion.');
  }

  const usage = (root.usage ?? {}) as Record<string, unknown>;
  const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null;
  const completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null;
  const finishReason: ParsedChatCompletion['finishReason'] =
    first.finish_reason === 'length' ? 'length' : first.finish_reason === 'stop' || first.finish_reason == null ? 'stop' : 'error';

  return {
    text: text.trim(),
    model: typeof root.model === 'string' ? root.model : requestedModel,
    promptTokens,
    completionTokens,
    usageEstimated: promptTokens === null || completionTokens === null,
    finishReason,
  };
}

/** §9 cost accounting. Returns null unless prices are configured — never a guess. */
export function estimateCostUsd(promptTokens: number, completionTokens: number): number | null {
  const c = config();
  if (c.LLM_PRICE_INPUT_PER_MTOK === undefined && c.LLM_PRICE_OUTPUT_PER_MTOK === undefined) return null;
  const inPrice = c.LLM_PRICE_INPUT_PER_MTOK ?? 0;
  const outPrice = c.LLM_PRICE_OUTPUT_PER_MTOK ?? 0;
  return Number(((promptTokens / 1_000_000) * inPrice + (completionTokens / 1_000_000) * outPrice).toFixed(6));
}

/* --------------------------------------------------------- embedding models */

/**
 * Deterministic hashing "embedding". It is NOT semantically meaningful and must
 * never be used to claim retrieval quality — it exists so the embedding cache,
 * batching and dimension checks in §5/§9 have something to exercise offline.
 *
 * The real system requires a multilingual model for Hindi↔English retrieval (§3);
 * that is configured via EMBEDDING_PROVIDER and validated at boot.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock';
  readonly isMock = true;
  readonly dimensions: number;

  constructor(dimensions = config().EMBEDDING_DIMENSIONS) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  describe(): ProviderDescription {
    return {
      name: 'mock',
      isMock: true,
      configured: true,
      baseUrl: null,
      model: config().EMBEDDING_MODEL,
      dimensions: this.dimensions,
      detail: 'hashing stand-in — not semantically meaningful, never a retrieval-quality claim',
    };
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

export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai-compatible';
  readonly isMock = false;
  readonly dimensions: number;
  readonly model: string;
  /** Accumulated across calls so `/health/ready` can report embedding spend honestly. */
  private embeddedChunks = 0;

  constructor(dimensions: number, model: string) {
    this.dimensions = dimensions;
    this.model = model;
  }

  get embeddedCount(): number {
    return this.embeddedChunks;
  }

  /**
   * Batches at `EMBEDDING_BATCH_SIZE` (§5 "embed (batched)") and verifies the
   * geometry of the reply: a vector of the wrong width would fail at the
   * `vector(1024)` column in the database, so it is rejected here with a message
   * that names the fix instead.
   */
  async embed(texts: string[]): Promise<number[][]> {
    const c = config();
    const target = requireTarget('embedding', c);
    if (texts.length === 0) return [];

    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += c.EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(i, i + c.EMBEDDING_BATCH_SIZE);
      let json: unknown;
      try {
        json = await postJson(target, '/embeddings', { model: this.model, input: batch });
      } catch (err) {
        const kind = err instanceof ProviderHttpError ? err.kind : 'network';
        logger.error('embedding call failed', { kind, batchSize: batch.length, model: this.model });
        throw providerUnavailable(
          kind === 'auth'
            ? 'The embedding provider rejected its credentials.'
            : 'The embedding provider is not responding; the document was not ingested.',
        );
      }

      const vectors = parseEmbeddingResponse(json, batch.length, this.dimensions);
      out.push(...vectors);
      this.embeddedChunks += batch.length;
    }
    return out;
  }

  describe(): ProviderDescription {
    const c = config();
    return {
      name: 'openai-compatible',
      isMock: false,
      configured: c.embeddingConfigured,
      baseUrl: maskUrl(c.EMBEDDING_BASE_URL ?? c.LLM_BASE_URL),
      model: this.model,
      dimensions: this.dimensions,
      detail: `${this.embeddedChunks} chunk(s) embedded this process; ${this.dimensions}-dimensional vectors`,
    };
  }
}

export function parseEmbeddingResponse(json: unknown, expected: number, dimensions: number): number[][] {
  const root = (json ?? {}) as Record<string, unknown>;
  const data = root.data;
  if (!Array.isArray(data)) {
    throw providerUnavailable('The embedding provider returned no `data` array.');
  }
  if (data.length !== expected) {
    throw providerUnavailable(
      `The embedding provider returned ${data.length} vector(s) for ${expected} input(s).`,
    );
  }
  // `index` is authoritative when present: some gateways reorder the array.
  const byIndex = new Map<number, number[]>();
  data.forEach((item, position) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const raw = entry.embedding;
    if (!Array.isArray(raw) || raw.length !== dimensions) {
      throw providerUnavailable(
        `Embedding dimension mismatch: the provider returned ${Array.isArray(raw) ? raw.length : 'no'} values but the schema is vector(${dimensions}). Set EMBEDDING_DIMENSIONS to the model's width and re-embed, or use a model of the configured width.`,
      );
    }
    const vector = raw.map((v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) throw providerUnavailable('The embedding provider returned a non-numeric value.');
      return n;
    });
    const idx = typeof entry.index === 'number' ? entry.index : position;
    byIndex.set(idx, vector);
  });

  const ordered: number[][] = [];
  for (let i = 0; i < expected; i += 1) {
    const vector = byIndex.get(i);
    if (!vector) throw providerUnavailable(`The embedding provider did not return a vector for input ${i}.`);
    ordered.push(vector);
  }
  return ordered;
}

/* ------------------------------------------------------------------- factory */

/**
 * Provider construction is cached: a new HTTP client per request would also mean a
 * new connection pool per request, and the readiness probe would then report the
 * embedding counter of a provider that had never embedded anything.
 */
let llmCache: LlmProvider | null = null;
let embeddingCache: EmbeddingProvider | null = null;
// One key for both clients: providerCacheKey() already covers the LLM and the embedding
// settings together, so an invalidation on either side replaces both instances.
let cacheKey = '';

function providerCacheKey(): string {
  const c = config();
  return [
    c.LLM_PROVIDER,
    c.EMBEDDING_PROVIDER,
    c.LLM_BASE_URL,
    c.EMBEDDING_BASE_URL,
    c.EMBEDDING_MODEL,
    c.EMBEDDING_DIMENSIONS,
  ].join('|');
}

export function resolveLlmProvider(): LlmProvider {
  const c = config();
  const key = providerCacheKey();
  if (llmCache && cacheKey === key) return llmCache;
  cacheKey = key;
  if (c.LLM_PROVIDER === 'mock') {
    llmCache = new MockLlmProvider();
  } else {
    // A configured-but-unreachable provider must fail loudly on the first call
    // (R8). Silently falling back to the mock would make a broken deployment look
    // exactly like a working one.
    llmCache = new OpenAiCompatibleLlmProvider();
  }
  return llmCache;
}

export function resolveEmbeddingProvider(): EmbeddingProvider {
  const c = config();
  const key = providerCacheKey();
  if (embeddingCache && cacheKey === key) return embeddingCache;
  cacheKey = key;
  if (c.EMBEDDING_PROVIDER === 'mock') {
    embeddingCache = new MockEmbeddingProvider(c.EMBEDDING_DIMENSIONS);
  } else {
    embeddingCache = new OpenAiCompatibleEmbeddingProvider(c.EMBEDDING_DIMENSIONS, c.EMBEDDING_MODEL);
  }
  return embeddingCache;
}

/** Drops the cached clients. Used by tests and by nothing at runtime. */
export function resetProviders(): void {
  llmCache = null;
  embeddingCache = null;
  cacheKey = '';
}

/** Rough token estimate (~4 chars/token). Used for budget accounting (§9). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
