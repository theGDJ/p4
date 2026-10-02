import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeProvider,
  startFakeProvider,
  useProviderConfig,
} from './helpers';
import { config, loadConfig, resetConfig, setConfigForTests } from '../src/config';
import { SYSTEM_PROMPT, MAX_OUTPUT_TOKENS, composeAnswer } from '../src/rag/answer';
import {
  MockLlmProvider,
  OpenAiCompatibleLlmProvider,
  OpenAiCompatibleEmbeddingProvider,
  estimateCostUsd,
  estimateTokens,
  parseChatCompletion,
  parseEmbeddingResponse,
  resolveEmbeddingProvider,
  resolveLlmProvider,
  resetProviders,
} from '../src/rag/providers';
import type { RetrievalResult } from '../src/rag/retrieve';
import type { KnowledgeChunkRow as ChunkRow, SourceSnapshot } from '../src/db/store';

/**
 * P2 — the real provider client (§3 "LLM + embeddings behind provider interfaces
 * (config-switchable, mockable in tests)").
 *
 * Everything here runs against a local stand-in server that speaks the
 * OpenAI-compatible wire format, because api.openai.com and
 * generativelanguage.googleapis.com are unreachable from this sandbox
 * (docs/ENVIRONMENT.md). What that proves: the request we send, the response we
 * parse, the retries, the timeouts and the error mapping. What it cannot prove:
 * that a specific vendor behaves as documented. That distinction is repeated in
 * README, docs/ENVIRONMENT.md and the PR body rather than glossed over.
 */

const TEST_KEY = 'sk-test-0123456789abcdef';
const OK_REPLY = {
  json: {
    choices: [{ message: { content: 'Answer text.' }, finish_reason: 'stop' }],
    model: 'vendor-large-2026',
    usage: { prompt_tokens: 1234, completion_tokens: 56 },
  },
};

let fake: FakeProvider | null = null;
const savedEnv: Record<string, string | undefined> = {};
const TRACKED = [
  'LLM_PROVIDER',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_LARGE_MODEL',
  'LLM_SMALL_MODEL',
  'LLM_MAX_RETRIES',
  'LLM_TIMEOUT_MS',
  'LLM_PRICE_INPUT_PER_MTOK',
  'LLM_PRICE_OUTPUT_PER_MTOK',
  'EMBEDDING_PROVIDER',
  'EMBEDDING_BASE_URL',
  'EMBEDDING_API_KEY',
  'EMBEDDING_MODEL',
  'EMBEDDING_BATCH_SIZE',
];

async function pointAt(overrides: Record<string, string> = {}): Promise<FakeProvider> {
  fake = await startFakeProvider();
  useProviderConfig({
    LLM_PROVIDER: 'openai-compatible',
    LLM_BASE_URL: fake.baseUrl,
    LLM_API_KEY: TEST_KEY,
    LLM_LARGE_MODEL: 'vendor-large-2026',
    LLM_SMALL_MODEL: 'vendor-small-2026',
    LLM_MAX_RETRIES: '1',
    LLM_TIMEOUT_MS: '2000',
    ...overrides,
  });
  return fake;
}

beforeEach(() => {
  for (const key of TRACKED) savedEnv[key] = process.env[key];
});

afterEach(async () => {
  await fake?.close();
  fake = null;
  for (const key of TRACKED) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetConfig();
  setConfigForTests(undefined);
  resetProviders();
});

function answerRequest(overrides: Partial<Parameters<OpenAiCompatibleLlmProvider['generate']>[0]> = {}) {
  return {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: 'user' as const, content: '<sources>\n[S1] IS 10500 — Clause 4.2\ntext\n</sources>' }],
    maxOutputTokens: 700,
    language: 'en' as const,
    intent: 'factual',
    ...overrides,
  };
}

describe('openai-compatible LLM: request shape', () => {
  it('posts to /chat/completions with the static system prompt first and temperature 0', async () => {
    const server = await pointAt();
    server.replies.push(OK_REPLY);

    const provider = new OpenAiCompatibleLlmProvider();
    const result = await provider.generate(answerRequest());

    expect(server.calls).toHaveLength(1);
    const call = server.calls[0]!;
    expect(call.path).toBe('/chat/completions');
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(call.headers['content-type']).toContain('application/json');

    const messages = call.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe('system');
    // §9: the system prompt is static and first so provider prefix caching applies.
    expect(messages[0]!.content).toBe(SYSTEM_PROMPT);
    expect(call.body.model).toBe('vendor-large-2026');
    expect(call.body.temperature).toBe(0);
    expect(call.body.max_tokens).toBe(700);
    expect(result.text).toBe('Answer text.');
    expect(result.model).toBe('vendor-large-2026');
    expect(result.finishReason).toBe('stop');
  });

  it('uses the small model for routing-shaped calls and the per-intent budget for answers (§9)', async () => {
    const server = await pointAt();
    server.replies.push(OK_REPLY, OK_REPLY);
    const provider = new OpenAiCompatibleLlmProvider();

    await provider.generate(answerRequest({ model: 'small' }));
    await provider.generate(answerRequest({ intent: 'certification', maxOutputTokens: MAX_OUTPUT_TOKENS.certification }));

    expect((server.calls[0]!.body as { model: string }).model).toBe('vendor-small-2026');
    expect((server.calls[1]!.body as { max_tokens: number }).max_tokens).toBe(MAX_OUTPUT_TOKENS.certification);
  });

  it('refuses to boot when a real provider is selected without a base URL or key', () => {
    // Stronger than failing on the first request: a deployment cannot come up half
    // configured and then discover it at the first user question (R8).
    expect(() =>
      loadConfig({
        ...process.env,
        LLM_PROVIDER: 'openai-compatible',
        LLM_BASE_URL: '',
        LLM_API_KEY: '',
      } as NodeJS.ProcessEnv),
    ).toThrow(/requires LLM_BASE_URL and LLM_API_KEY/);
  });
});

describe('openai-compatible LLM: response parsing', () => {
  it('trusts the provider usage block when present and marks it estimated when not', async () => {
    const server = await pointAt();
    server.replies.push(OK_REPLY, { json: { choices: [{ message: { content: 'x'.repeat(400) }, finish_reason: 'stop' }] } });
    const provider = new OpenAiCompatibleLlmProvider();

    const withUsage = await provider.generate(answerRequest());
    expect(withUsage.promptTokens).toBe(1234);
    expect(withUsage.completionTokens).toBe(56);
    expect(withUsage.usageEstimated).toBe(false);

    const withoutUsage = await provider.generate(answerRequest());
    expect(withoutUsage.usageEstimated).toBe(true);
    // The estimate is ~4 characters/token over the exact messages sent, so it is
    // reproducible in a test — and it must never be presented as a provider figure.
    const sent = (server.calls[1]!.body as { messages: Array<{ content: string }> }).messages;
    expect(withoutUsage.promptTokens).toBe(sent.reduce((n, m) => n + estimateTokens(m.content), 0));
    expect(withoutUsage.promptTokens).toBeGreaterThan(100);
    expect(withoutUsage.completionTokens).toBeGreaterThan(90);
  });

  it('reads content from the parts-array form some gateways return', async () => {
    const server = await pointAt();
    server.replies.push({
      json: { choices: [{ message: { content: [{ type: 'text', text: 'Part one ' }, { type: 'text', text: 'part two.' }] }, finish_reason: 'stop' }] },
    });
    const result = await new OpenAiCompatibleLlmProvider().generate(answerRequest());
    expect(result.text).toBe('Part one part two.');
  });

  it('treats finish_reason length as a truncated answer, not a complete one', async () => {
    const server = await pointAt();
    server.replies.push({ json: { choices: [{ message: { content: 'half a sentence' }, finish_reason: 'length' }] } });
    const result = await new OpenAiCompatibleLlmProvider().generate(answerRequest());
    expect(result.finishReason).toBe('length');
  });

  it('fails loudly on an empty or missing completion instead of showing a blank answer (R8)', async () => {
    const server = await pointAt();
    server.replies.push({ json: { choices: [{ message: { content: '   ' }, finish_reason: 'stop' }] } }, { json: {} });
    const provider = new OpenAiCompatibleLlmProvider();
    await expect(provider.generate(answerRequest())).rejects.toThrow(/empty completion/);
    await expect(provider.generate(answerRequest())).rejects.toThrow(/no completion/);
  });

  it('maps an auth failure to one generic message and never echoes the key or the URL', async () => {
    const server = await pointAt();
    server.replies.push({ status: 401, json: { error: { message: `bad key ${TEST_KEY} for ${server.baseUrl}` } } });
    const provider = new OpenAiCompatibleLlmProvider();
    const err = await provider.generate(answerRequest()).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/credentials/);
    expect(message).not.toContain(TEST_KEY);
    expect(message).not.toContain('127.0.0.1');
    // A rejected credential will not succeed on a retry, so it must not be retried.
    expect(server.calls).toHaveLength(1);
  });

  it('retries a 429 and honours Retry-After, then succeeds', async () => {
    const server = await pointAt({ LLM_MAX_RETRIES: '2' });
    server.replies.push({ status: 429, json: {}, headers: { 'retry-after': '0' } }, OK_REPLY);
    const result = await new OpenAiCompatibleLlmProvider().generate(answerRequest());
    expect(result.text).toBe('Answer text.');
    expect(server.calls).toHaveLength(2);
  });

  it('gives up after the configured attempts on a 5xx, with a provider-unavailable error', async () => {
    const server = await pointAt({ LLM_MAX_RETRIES: '2', LLM_TIMEOUT_MS: '1000' });
    server.replies.push({ status: 503, json: {} }, { status: 503, json: {} }, { status: 503, json: {} });
    await expect(new OpenAiCompatibleLlmProvider().generate(answerRequest())).rejects.toThrow(/not responding/);
    expect(server.calls).toHaveLength(3);
  });

  it('aborts a provider that never answers, rather than hanging the stream', async () => {
    // 1000ms is the smallest timeout the contract accepts (a slower one would make a
    // stalled provider hold an SSE connection for minutes).
    const server = await pointAt({ LLM_MAX_RETRIES: '0', LLM_TIMEOUT_MS: '1000' });
    server.replies.push({ json: OK_REPLY.json, delayMs: 3_000 });
    await expect(new OpenAiCompatibleLlmProvider().generate(answerRequest())).rejects.toThrow(/not responding|timed out/);
  });
});

describe('cost accounting (§9)', () => {
  it('reports null rather than a guess when no pricing is configured', async () => {
    await pointAt({ LLM_PRICE_INPUT_PER_MTOK: '', LLM_PRICE_OUTPUT_PER_MTOK: '' });
    const server = fake!;
    server.replies.push(OK_REPLY);
    const result = await new OpenAiCompatibleLlmProvider().generate(answerRequest());
    expect(result.costUsd).toBeNull();
    expect(estimateCostUsd(1_000_000, 0)).toBeNull();
  });

  it('computes cost from the configured per-MTok prices', async () => {
    await pointAt({ LLM_PRICE_INPUT_PER_MTOK: '2.5', LLM_PRICE_OUTPUT_PER_MTOK: '10' });
    const server = fake!;
    server.replies.push(OK_REPLY);
    const result = await new OpenAiCompatibleLlmProvider().generate(answerRequest());
    // 1234 in @2.5/MTok + 56 out @10/MTok
    expect(result.costUsd).toBeCloseTo((1234 / 1e6) * 2.5 + (56 / 1e6) * 10, 8);
  });
});

describe('openai-compatible embeddings', () => {
  it('batches at EMBEDDING_BATCH_SIZE and returns vectors in request order', async () => {
    const server = await pointAt({ EMBEDDING_PROVIDER: 'openai-compatible', EMBEDDING_BATCH_SIZE: '2', EMBEDDING_MODEL: 'test-embed' });
    // Five texts, batch size 2 -> 3 calls; each reply is deliberately shuffled so
    // the client must re-order by `index` rather than trusting response order.
    const batchSizes = [2, 2, 1];
    for (const size of batchSizes) {
      server.replies.push({
        json: {
          model: 'test-embed',
          // Deliberately out of order: the client must re-sort by `index`.
          data: Array.from({ length: size }, (_, i) => i)
            .map((i) => ({ index: i, embedding: [i + 1, 0, 0, 0] }))
            .reverse(),
        },
      });
    }
    const provider = new OpenAiCompatibleEmbeddingProvider(4, 'test-embed');
    const vectors = await provider.embed(['a', 'b', 'c', 'd', 'e']);
    expect(server.calls.map((c) => c.path)).toEqual(['/embeddings', '/embeddings', '/embeddings']);
    expect(vectors).toHaveLength(5);
    expect(vectors[0]).toEqual([1, 0, 0, 0]);
    expect(vectors[1]).toEqual([2, 0, 0, 0]);
    expect(vectors[2]).toEqual([1, 0, 0, 0]);
    expect((server.calls[0]!.body as { input: string[] }).input).toEqual(['a', 'b']);
  });

  it('rejects a vector of the wrong width with a message that names the fix', async () => {
    const server = await pointAt({ EMBEDDING_PROVIDER: 'openai-compatible' });
    server.replies.push({ json: { data: [{ index: 0, embedding: [0.1, 0.2] }] } });
    const provider = new OpenAiCompatibleEmbeddingProvider(1024, 'test-embed');
    await expect(provider.embed(['one text'])).rejects.toThrow(/vector\(1024\)/);
    expect(provider.embeddedCount).toBe(0);
  });

  it('rejects a short batch instead of storing nulls', async () => {
    const server = await pointAt({ EMBEDDING_PROVIDER: 'openai-compatible', EMBEDDING_BATCH_SIZE: '4' });
    server.replies.push({ json: { data: [{ index: 0, embedding: [1, 2, 3, 4] }] } });
    await expect(new OpenAiCompatibleEmbeddingProvider(4, 'test-embed').embed(['a', 'b', 'c'])).rejects.toThrow(
      /1 vector\(s\) for 3 input\(s\)/,
    );
  });
});

describe('provider response parsers (unit)', () => {
  it('parseChatCompletion accepts a missing finish_reason as a normal stop', () => {
    const parsed = parseChatCompletion({ choices: [{ message: { content: 'text' } }] }, 'fallback-model');
    expect(parsed.finishReason).toBe('stop');
    expect(parsed.model).toBe('fallback-model');
  });

  it('parseChatCompletion throws on no choices at all', () => {
    expect(() => parseChatCompletion({ choices: [] }, 'm')).toThrow(/no completion/);
  });

  it('parseEmbeddingResponse requires one vector per input and finite numbers', () => {
    expect(() => parseEmbeddingResponse({ data: [] }, 1, 2)).toThrow(/0 vector\(s\) for 1 input/);
    expect(() => parseEmbeddingResponse({ data: [{ index: 0, embedding: [1, Number.NaN] }] }, 1, 2)).toThrow(/non-numeric/);
    expect(parseEmbeddingResponse({ data: [{ index: 0, embedding: [1, 2] }] }, 1, 2)).toEqual([[1, 2]]);
  });
});

describe('provider selection', () => {
  it('the mock provider is what an unconfigured deployment gets, and it says so', async () => {
    resetConfig();
    setConfigForTests(
      loadConfig({ ...process.env, LLM_PROVIDER: 'mock', EMBEDDING_PROVIDER: 'mock' } as NodeJS.ProcessEnv),
    );
    resetProviders();
    const llm = resolveLlmProvider();
    expect(llm.isMock).toBe(true);
    expect(llm.describe().configured).toBe(true);
    expect(llm.describe().baseUrl).toBeNull();
    const embeddings = resolveEmbeddingProvider();
    expect(embeddings.isMock).toBe(true);
    expect(embeddings.dimensions).toBe(config().EMBEDDING_DIMENSIONS);
    // Deterministic: the same text embeds to the same vector, twice.
    const [first] = await embeddings.embed(['water purity']);
    const [second] = await embeddings.embed(['water purity']);
    expect(first).toEqual(second);
  });

  it('an unknown provider name is a boot error, not a silent fallback to the mock (R8)', () => {
    expect(() =>
      loadConfig({ ...process.env, LLM_PROVIDER: 'gpt-cloud-9000' } as NodeJS.ProcessEnv),
    ).toThrow(/LLM_PROVIDER/);
  });

  it('resolveLlmProvider caches per configuration so pools and counters survive requests', async () => {
    await pointAt();
    const a = resolveLlmProvider();
    const b = resolveLlmProvider();
    expect(a).toBe(b);
    useProviderConfig({ LLM_BASE_URL: fake!.baseUrl, LLM_API_KEY: TEST_KEY, LLM_LARGE_MODEL: 'other-model' });
    expect(resolveLlmProvider()).not.toBe(a);
  });

  it('the mock provider never claims to have generated a grounded answer', async () => {
    resetConfig();
    setConfigForTests(loadConfig({ ...process.env, LLM_PROVIDER: 'mock' } as NodeJS.ProcessEnv));
    resetProviders();
    const provider = new MockLlmProvider();
    const result = await provider.generate(answerRequest({ maxOutputTokens: 8 }));
    expect(result.text.startsWith('[MOCK PROVIDER]')).toBe(true);
    expect(result.costUsd).toBe(0);
  });
});

/* ------------------------------------------------- pipeline with a real provider */

function sourceFor(ref: string, score: number): SourceSnapshot {
  return {
    ref,
    chunkId: `chunk-${ref}`,
    documentVersionId: 'version-1',
    title: 'IS 10500:2012 Stainless Steel Sheet and Plate',
    standardNo: 'IS 10500:2012',
    section: 'Clause 4.2',
    docType: 'STANDARD',
    language: 'en',
    sourceUrl: 'https://example.test/is-10500',
    verificationStatus: 'VERIFIED',
    verifiedAt: '2026-01-01T00:00:00Z',
    snippet: 'The material shall conform to the chemical composition requirements.',
    score,
  };
}

function retrieval(sources: SourceSnapshot[]): RetrievalResult {
  return {
    // Only `score`/`reason` and the snapshot matter to the pipeline; the chunk rows
    // are stand-ins so nothing in this file pretends a fake row is a real one.
    hits: sources.map((s) => ({
      chunk: { id: s.chunkId, documentVersionId: s.documentVersionId, content: s.snippet } as ChunkRow,
      score: s.score,
      reason: 'test fixture',
      method: 'lexical' as const,
    })),
    sources,
    context: sources.map((s) => `[${s.ref}] ${s.title}\n${s.snippet}`).join('\n\n'),
    contextTokens: 240,
    kbVersion: 3,
    latencyMs: 5,
    empty: sources.length === 0,
  };
}

describe('answer pipeline against a real provider', () => {
  it('streams a validated, cited answer and rates it STRONG from the rules, not the model', async () => {
    const server = await pointAt();
    server.replies.push({
      json: {
        choices: [
          {
            message: {
              content:
                'From sources: IS 10500:2012 covers stainless steel sheet and plate [S1]. The chemical composition requirements are in Clause 4.2 [S2].\nExplanation: this tells you which standard to read.\nFOLLOWUPS: Does it cover bars? | What about corrosion testing? | Which clause lists tolerances?',
            },
            finish_reason: 'stop',
          },
        ],
        model: 'vendor-large-2026',
        usage: { prompt_tokens: 900, completion_tokens: 120 },
      },
    });

    const composed = await composeAnswer({
      provider: new OpenAiCompatibleLlmProvider(),
      retrieval: retrieval([sourceFor('S1', 0.42), sourceFor('S2', 0.31)]),
      intent: 'factual',
      language: 'en',
      userText: 'Which standard covers stainless steel plate?',
    });

    expect(composed.providerError).toBeNull();
    expect(composed.evidenceTier).toBe('STRONG');
    expect(composed.validation?.allCitationsValid).toBe(true);
    expect(composed.validation?.removedSentences).toEqual([]);
    expect(composed.followUps).toHaveLength(3);
    expect(composed.usage.promptTokens).toBe(900);
    expect(composed.usage.costUsd).toBeNull();
    expect(composed.truncated).toBe(false);
    // R3: the model never gets to name a source; the snapshot is from the store.
    expect(composed.sources[0]!.title).toBe('IS 10500:2012 Stainless Steel Sheet and Plate');
    expect(server.calls).toHaveLength(1);
  });

  it('removes an uncited factual sentence and downgrades the tier (R3)', async () => {
    await pointAt();
    fake!.replies.push({
      json: {
        choices: [
          {
            message: {
              content:
                'From sources: IS 10500:2012 applies to sheet and plate [S1]. The licence fee is ₹1000 per year and takes 30 days.',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      },
    });

    const composed = await composeAnswer({
      provider: new OpenAiCompatibleLlmProvider(),
      retrieval: retrieval([sourceFor('S1', 0.4)]),
      intent: 'factual',
      language: 'en',
      userText: 'Which standard, and what does it cost?',
    });

    expect(composed.text).not.toMatch(/₹1000/);
    expect(composed.validation?.removedSentences).toHaveLength(1);
    // One usable chunk, citations valid but the set is thin: PARTIAL, never STRONG.
    expect(composed.evidenceTier).toBe('PARTIAL');
  });

  it('still returns the retrieved sources when the provider fails mid-answer (R8)', async () => {
    await pointAt({ LLM_MAX_RETRIES: '0' });
    fake!.replies.push({ status: 500, json: {} });
    await expect(
      composeAnswer({
        provider: new OpenAiCompatibleLlmProvider(),
        retrieval: retrieval([sourceFor('S1', 0.4)]),
        intent: 'factual',
        language: 'en',
        userText: 'Anything',
      }),
    ).rejects.toThrow(/not responding/);
  });

  it('announces truncation when the provider hit its output limit', async () => {
    await pointAt();
    fake!.replies.push({
      json: {
        choices: [{ message: { content: 'From sources: it applies to plate [S1]. And more detail' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 700 },
      },
    });
    const composed = await composeAnswer({
      provider: new OpenAiCompatibleLlmProvider(),
      retrieval: retrieval([sourceFor('S1', 0.4), sourceFor('S2', 0.3)]),
      intent: 'factual',
      language: 'en',
      userText: 'Tell me everything',
    });
    expect(composed.truncated).toBe(true);
    expect(composed.text).toMatch(/cut short by the model output limit/);
  });
});
