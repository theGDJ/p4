import { createApp } from './app';
import { config } from './config';
import { db } from './db/store';
import { seedDemoUsers } from './dev-seed';
import { hashingStatus } from './lib/password';
import { logger } from './lib/logger';

/**
 * Boots the mock API.
 *
 * This process is the runnable half of the stack in sandboxes without a JDK,
 * Docker, PostgreSQL or Redis (docs/ENVIRONMENT.md). It implements
 * docs/API.md exactly, so the frontend cannot tell it apart from `backend/`.
 */
async function main(): Promise<void> {
  const c = config();
  const store = db();

  await seedDemoUsers(store);

  const app = createApp(store);
  const server = app.listen(c.PORT, c.HOST, () => {
    logger.info('mock API listening', {
      host: c.HOST,
      port: c.PORT,
      basePath: c.API_BASE_PATH,
      env: c.NODE_ENV,
      passwordScheme: hashingStatus().scheme,
      llmProvider: c.LLM_PROVIDER,
      embeddingProvider: c.EMBEDDING_PROVIDER,
      csrfEnabled: c.CSRF_ENABLED,
      cookieSecure: c.COOKIE_SECURE,
      corsOrigins: c.CORS_ALLOWED_ORIGINS,
    });
    if (c.LLM_PROVIDER === 'mock') {
      logger.warn(
        'LLM_PROVIDER=mock: retrieval, citation validation and the R4 fallback are exercised, but no grounded answer can be generated. Set LLM_PROVIDER and credentials, or run the Spring Boot backend, for real generation.',
      );
    }
  });

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    server.close(() => process.exit(0));
    // Do not hang forever if a connection refuses to drain.
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { reason });
  });
}

main().catch((err) => {
  // Boot failures must be loud (R8): never start half-configured.
  process.stderr.write(`Failed to start mock API: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
