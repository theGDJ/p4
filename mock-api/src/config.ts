import { z } from 'zod';

/**
 * Environment configuration. Every value is validated at boot so a missing secret
 * fails loudly at startup rather than silently degrading at request time (R8).
 *
 * P2 added the provider, ingestion, mail and cache blocks. The rule for all of
 * them is the same: a half-configured integration is a boot error, never a runtime
 * surprise and never a silently-degraded-but-looks-fine answer.
 */

function booleanish(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : /^(1|true|yes|on)$/i.test(v)));
}

/** Empty string means "not set" so `.env.example` can carry commented placeholders. */
function optionalString(min = 1) {
  return z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim().length === 0 ? undefined : v.trim()))
    .refine((v) => v === undefined || v.length >= min, `must be at least ${min} characters when set`);
}

function optionalUrl() {
  return z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim().length === 0 ? undefined : v.trim().replace(/\/+$/, '')))
    .refine((v) => v === undefined || /^https?:\/\/[^\s]+$/i.test(v), 'must be an http(s) URL when set');
}

function optionalPrice() {
  return z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim().length === 0) return undefined;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    });
}

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8081),
  HOST: z.string().default('0.0.0.0'),
  API_BASE_PATH: z.string().startsWith('/').default('/api/v1'),
  /** Where the browser reaches this app; used to build links inside outbound mail. */
  APP_PUBLIC_URL: optionalUrl(),

  // Secrets. In test we accept the built-in dev defaults so suites run without a .env;
  // in production an absent secret is a fatal boot error.
  JWT_ACCESS_SECRET: z.string().min(32).default('dev-only-access-secret-change-me-32bytes!'),
  JWT_ACCESS_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(14),

  COOKIE_SECURE: booleanish(true),
  COOKIE_SAME_SITE: z.enum(['Lax', 'Strict', 'None']).default('Lax'),
  COOKIE_DOMAIN: optionalString(),

  ARGON2_MEMORY_KIB: z.coerce.number().int().positive().default(19456),
  ARGON2_ITERATIONS: z.coerce.number().int().positive().default(2),
  ARGON2_PARALLELISM: z.coerce.number().int().positive().default(1),

  LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),

  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://127.0.0.1:5173')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),

  CSRF_ENABLED: booleanish(true),

  /* ------------------------------------------------------------- providers */

  /**
   * `mock` is the only offline default. `openai-compatible` covers OpenAI itself and
   * any gateway that speaks the `/chat/completions` + `/embeddings` shape (vLLM,
   * Ollama, Azure's compatibility endpoint, Gemini's `/v1beta/openai`).
   */
  LLM_PROVIDER: z.enum(['mock', 'openai-compatible']).default('mock'),
  LLM_BASE_URL: optionalUrl(),
  LLM_API_KEY: optionalString(8),
  LLM_SMALL_MODEL: z.string().default('mock-small'),
  LLM_LARGE_MODEL: z.string().default('mock-large'),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(180_000).default(45_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(4).default(2),
  /**
   * Pricing is only reported when configured. Without it `costUsd` is null — an
   * invented dollar figure in a cost budget would be exactly the kind of fake
   * number §11/R10 forbids.
   */
  LLM_PRICE_INPUT_PER_MTOK: optionalPrice(),
  LLM_PRICE_OUTPUT_PER_MTOK: optionalPrice(),

  EMBEDDING_PROVIDER: z.enum(['mock', 'openai-compatible']).default('mock'),
  EMBEDDING_BASE_URL: optionalUrl(),
  EMBEDDING_API_KEY: optionalString(8),
  EMBEDDING_MODEL: z.string().default('mock-multilingual-1'),
  /** Must match `knowledge_chunks.embedding vector(1024)` in V1__init.sql. */
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).max(256).default(32),
  EMBEDDING_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  EMBEDDING_MAX_RETRIES: z.coerce.number().int().min(0).max(4).default(2),
  EMBEDDING_PRICE_PER_MTOK: optionalPrice(),

  /* ------------------------------------------------------------ §9 caching */

  ANSWER_CACHE_ENABLED: booleanish(true),
  ANSWER_CACHE_TTL_SECONDS: z.coerce.number().int().min(10).max(86_400).default(900),
  ANSWER_CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).max(10_000).default(500),

  /* ------------------------------------------------------------- ingestion */

  INGEST_MAX_BYTES: z.coerce.number().int().min(1024).max(200_000_000).default(25_000_000),
  INGEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  INGEST_MAX_REDIRECTS: z.coerce.number().int().min(0).max(6).default(3),
  /**
   * Outbound fetches are for public official sources. Fetching an operator-supplied
   * URL from the server is an SSRF vector, so loopback/RFC1918/link-local are
   * refused unless this is explicitly flipped. It exists so the ingestion pipeline
   * can be end-to-end tested against a local fixture, and it is a fatal boot error
   * in production.
   */
  INGEST_ALLOW_PRIVATE_NETWORKS: booleanish(false),
  INGEST_USER_AGENT: z.string().min(8).max(200).default('BIS-Saathi-knowledge-ingestion/0.1'),
  INGEST_MAX_PAGES: z.coerce.number().int().min(1).max(500).default(120),

  CHUNK_MIN_TOKENS: z.coerce.number().int().min(50).default(300),
  CHUNK_MAX_TOKENS: z.coerce.number().int().min(100).max(1200).default(500),
  /** §5 "~10% overlap". Expressed as a fraction of the target chunk size. */
  CHUNK_OVERLAP_RATIO: z.coerce.number().min(0).max(0.25).default(0.1),

  /* ------------------------------------------------------------------ mail */

  /**
   * `log` prints the message to stdout and is the development default; `none`
   * records that nothing was sent (the API never claims delivery it did not make);
   * `smtp` uses nodemailer against SMTP_URL or the SMTP_* parts.
   */
  MAIL_TRANSPORT: z.enum(['none', 'log', 'smtp']).default('log'),
  SMTP_URL: optionalString(),
  SMTP_HOST: optionalString(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  SMTP_SECURE: booleanish(false),
  SMTP_USER: optionalString(),
  SMTP_PASS: optionalString(),
  SMTP_FROM: optionalString(),
  /** Reset links are absolute; without APP_PUBLIC_URL the mail body says "use the token". */
  MAIL_SUBJECT_PREFIX: z.string().max(64).default('[BIS-Saathi]'),

  // Lower-cased on the way in: Spring reads `logging.level.root=INFO` and this file is
  // shared by both stacks, so a template value of `INFO` has to work here too rather
  // than refusing to boot over letter case.
  LOG_LEVEL: z.preprocess(
    (v) => (typeof v === 'string' ? v.toLowerCase() : v),
    z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  ),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
  LOG_PII_REDACTION: booleanish(true),
});

export type AppConfig = z.infer<typeof Schema> & {
  isTest: boolean;
  isProduction: boolean;
  /** True when generation would actually reach a model, so readiness can say so. */
  llmConfigured: boolean;
  embeddingConfigured: boolean;
  /** True when prices are configured, i.e. when `costUsd` means anything (§9). */
  costAccounting: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Fail loudly at boot (R8). Never start with an invalid security configuration.
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const c = parsed.data;
  const isTest = c.NODE_ENV === 'test';
  const isProduction = c.NODE_ENV === 'production';

  const llmConfigured =
    c.LLM_PROVIDER === 'openai-compatible' && !!c.LLM_BASE_URL && !!c.LLM_API_KEY;
  const embeddingConfigured =
    c.EMBEDDING_PROVIDER === 'openai-compatible' &&
    !!(c.EMBEDDING_BASE_URL ?? c.LLM_BASE_URL) &&
    !!(c.EMBEDDING_API_KEY ?? c.LLM_API_KEY);
  const costAccounting =
    c.LLM_PRICE_INPUT_PER_MTOK !== undefined || c.LLM_PRICE_OUTPUT_PER_MTOK !== undefined;

  const offenders: string[] = [];
  const notes: string[] = [];

  if (c.LLM_PROVIDER === 'openai-compatible' && !llmConfigured) {
    offenders.push('LLM_PROVIDER=openai-compatible requires LLM_BASE_URL and LLM_API_KEY');
  }
  if (c.EMBEDDING_PROVIDER === 'openai-compatible' && !embeddingConfigured) {
    offenders.push(
      'EMBEDDING_PROVIDER=openai-compatible requires EMBEDDING_BASE_URL and EMBEDDING_API_KEY (or the LLM_* pair)',
    );
  }
  // vector(1024) is fixed in V1__init.sql; a different width needs a migration and
  // a full re-embed, which is a deliberate act, not an environment variable.
  if (c.EMBEDDING_DIMENSIONS !== 1024) {
    notes.push(
      `EMBEDDING_DIMENSIONS=${c.EMBEDDING_DIMENSIONS} does not match vector(1024) in V1__init.sql — chunks will be rejected at insert time until the column and the model agree`,
    );
  }

  if (isProduction) {
    if (c.JWT_ACCESS_SECRET.startsWith('dev-only')) offenders.push('JWT_ACCESS_SECRET');
    if (c.CORS_ALLOWED_ORIGINS.some((o) => o.includes('*'))) offenders.push('CORS_ALLOWED_ORIGINS');
    if (!c.COOKIE_SECURE) offenders.push('COOKIE_SECURE');
    // Password reset is the one flow that cannot be completed in-app: promising a
    // mail we never send is a false success (R8), so production must configure one.
    if (c.MAIL_TRANSPORT !== 'smtp') {
      offenders.push('MAIL_TRANSPORT must be smtp in production (or password reset cannot be delivered)');
    }
    if (c.MAIL_TRANSPORT === 'smtp' && !c.SMTP_URL && !c.SMTP_HOST) {
      offenders.push('MAIL_TRANSPORT=smtp requires SMTP_URL or SMTP_HOST');
    }
    if (c.MAIL_TRANSPORT === 'smtp' && !c.SMTP_FROM) {
      offenders.push('MAIL_TRANSPORT=smtp requires SMTP_FROM');
    }
    if (c.INGEST_ALLOW_PRIVATE_NETWORKS) {
      offenders.push('INGEST_ALLOW_PRIVATE_NETWORKS must be false in production (SSRF)');
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      `Refusing to start with insecure or incomplete configuration:\n${offenders.map((o) => `  - ${o}`).join('\n')}`,
    );
  }
  if (notes.length > 0 && !isTest) {
    for (const n of notes) process.stderr.write(`config warning: ${n}\n`);
  }

  return {
    ...c,
    isTest,
    isProduction,
    llmConfigured,
    embeddingConfigured,
    costAccounting,
  };
}

let cached: AppConfig | undefined;

/** Process-wide config. Tests call `resetConfig()` to force a reload. */
export function config(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

export function resetConfig(): void {
  cached = undefined;
}

/** Test seam: force a config built from `env` for the duration of a suite. */
export function setConfigForTests(next: AppConfig | undefined): void {
  cached = next;
}
