import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    env: {
      NODE_ENV: 'test',
      COOKIE_SECURE: 'false',
      CSRF_ENABLED: 'true',
      LOG_LEVEL: 'silent',
      LOG_PII_REDACTION: 'true',
      JWT_ACCESS_SECRET: 'test-access-secret-value-that-is-long-enough-32',
      // Small windows so lockout and rate-limit behaviour is observable quickly.
      LOGIN_MAX_FAILED_ATTEMPTS: '5',
      LOGIN_LOCKOUT_MINUTES: '15',
      RATE_LIMIT_AUTH_MAX: '10',
      RATE_LIMIT_MAX_REQUESTS: '120',
      RATE_LIMIT_WINDOW_SECONDS: '60',
    },
  },
});
