import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { config } from './config';
import { createStore, db, type Store } from './db/store';
import { errorHandler, notFoundHandler } from './lib/errors';
import { logger } from './lib/logger';
import { globalRateLimit } from './lib/rateLimit';
import { JSON_BODY_LIMIT } from './lib/validate';
import { adminRouter, healthRouter } from './modules/meta/routes';
import { authRouter } from './modules/auth/routes';
import { chatRouter } from './modules/chat/routes';
import { userRouter } from './modules/user/routes';
import { requestContext } from './security/middleware';

/**
 * Express application factory.
 *
 * Middleware order is deliberate:
 *   headers -> CORS -> body limit -> rate limit -> trace/store context -> routes -> 404 -> error
 *
 * Security controls implemented here mirror `backend/.../security/SecurityConfig.java`
 * so the two stacks are not merely API-compatible but behave the same way.
 */
export function createApp(store: Store = db()): Express {
  const c = config();
  const app = express();

  // Behind the Vite dev proxy (and nginx in the Compose stack) the socket peer is
  // the proxy, so one hop must be trusted for client IP / rate limiting to work.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // §8 security headers. This is a JSON API, so the CSP forbids rendering entirely.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'none'"],
          'form-action': ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: c.COOKIE_SECURE ? { maxAge: 31_536_000, includeSubDomains: true, preload: false } : false,
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin/curl requests have no Origin header and must be allowed.
        if (!origin) return callback(null, true);
        if (c.CORS_ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        // Deny by omitting the ACAO header — the browser then blocks the response.
        // Throwing here would turn a CORS mismatch into a 500, which is both a
        // worse failure mode and an information leak about server internals.
        logger.warn('CORS rejection', { origin });
        return callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-XSRF-TOKEN', 'Accept'],
      exposedHeaders: ['X-Trace-Ref', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'Retry-After'],
      maxAge: 600,
    }),
  );

  // §8: request size limits before parsing.
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: JSON_BODY_LIMIT }));
  app.use(cookieParser());

  app.use(globalRateLimit());
  app.use(requestContext(store));

  const base = c.API_BASE_PATH;
  app.use(base, healthRouter(store));
  app.use(`${base}/auth`, authRouter(store));
  app.use(`${base}/users`, userRouter(store));
  app.use(`${base}/conversations`, chatRouter(store));
  app.use(base, adminRouter(store));

  // A tiny root pointer so hitting the bare port is not a mystery 404.
  app.get('/', (_req, res) => {
    res.json({
      service: 'BIS-Saathi mock API',
      docs: 'docs/API.md',
      health: `${base}/health/live`,
      note: 'Dev-only stand-in for the Spring Boot backend. See docs/ENVIRONMENT.md.',
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export { createStore };
