import { z } from 'zod';

/**
 * Environment configuration. Every value is validated at boot so a missing secret
 * fails loudly at startup rather than silently degrading at request time (R8).
 */

function booleanish(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : /^(1|true|yes|on)$/i.test(v)));
}

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8081),
  HOST: z.string().default('0.0.0.0'),
  API_BASE_PATH: z.string().startsWith('/').default('/api/v1'),

  // Secrets. In test we accept the built-in dev defaults so suites run without a .env;
  // in production an absent secret is a fatal boot error.
  JWT_ACCESS_SECRET: z.string().min(32).default('dev-only-access-secret-change-me-32bytes!'),
  JWT_ACCESS_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(14),

  COOKIE_SECURE: booleanish(true),
  COOKIE_SAME_SITE: z.enum(['Lax', 'Strict', 'None']).default('Lax'),
  COOKIE_DOMAIN: z.string().optional(),

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

  LLM_PROVIDER: z.string().default('mock'),
  LLM_SMALL_MODEL: z.string().default('mock-small'),
  LLM_LARGE_MODEL: z.string().default('mock-large'),
  EMBEDDING_PROVIDER: z.string().default('mock'),
  EMBEDDING_MODEL: z.string().default('mock-multilingual-1'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
  LOG_PII_REDACTION: booleanish(true),
});

export type AppConfig = z.infer<typeof Schema> & { isTest: boolean; isProduction: boolean };

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

  if (isProduction) {
    const offenders: string[] = [];
    if (c.JWT_ACCESS_SECRET.startsWith('dev-only')) offenders.push('JWT_ACCESS_SECRET');
    if (c.CORS_ALLOWED_ORIGINS.some((o) => o.includes('*'))) offenders.push('CORS_ALLOWED_ORIGINS');
    if (!c.COOKIE_SECURE) offenders.push('COOKIE_SECURE');
    if (offenders.length > 0) {
      throw new Error(
        `Refusing to start in production with insecure configuration: ${offenders.join(', ')}`,
      );
    }
  }

  return { ...c, isTest, isProduction };
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
