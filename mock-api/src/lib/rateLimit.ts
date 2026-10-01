import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config';
import { rateLimited } from './errors';

/**
 * Fixed-window rate limiter (§8).
 *
 * In the Spring Boot backend this is backed by Redis (`INCR` + `EXPIRE`) so it is
 * shared across instances; here it is process-local, which is correct for a
 * single-node dev server and keeps the observable behaviour identical.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly windowSeconds: number, private readonly max: number) {}

  consume(key: string, now = Date.now()): { allowed: boolean; remaining: number; retryAfterSeconds: number; limit: number } {
    const windowMs = this.windowSeconds * 1000;
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    const allowed = bucket.count <= this.max;
    return {
      allowed,
      remaining: Math.max(this.max - bucket.count, 0),
      retryAfterSeconds: Math.max(Math.ceil((bucket.resetAt - now) / 1000), 1),
      limit: this.max,
    };
  }

  reset(key?: string): void {
    if (key === undefined) this.buckets.clear();
    else this.buckets.delete(key);
  }

  /** Test/ops helper: drop buckets whose window has elapsed. */
  sweep(now = Date.now()): void {
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
  }
}

export function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export interface RateLimitOptions {
  /** Bucket name; keys are namespaced by it so limits do not interfere. */
  name: string;
  max?: number;
  windowSeconds?: number;
  /** Extra key material, e.g. the submitted email, so one user cannot be locked out by another. */
  keyBy?: (req: Request) => string;
}

export function rateLimit(opts: RateLimitOptions): RequestHandler {
  const c = config();
  const limiter = new RateLimiter(
    opts.windowSeconds ?? c.RATE_LIMIT_WINDOW_SECONDS,
    opts.max ?? c.RATE_LIMIT_MAX_REQUESTS,
  );

  const handler = (req: Request, _res: Response, next: NextFunction): void => {
    const extra = opts.keyBy ? `:${opts.keyBy(req)}` : '';
    const result = limiter.consume(`${opts.name}:${clientIp(req)}${extra}`);
    _res.setHeader('X-RateLimit-Limit', String(result.limit));
    _res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    if (!result.allowed) {
      next(rateLimited(result.retryAfterSeconds));
      return;
    }
    next();
  };

  // Exposed so tests can assert on a fresh limiter without restarting the app.
  (handler as RequestHandler & { limiter?: RateLimiter }).limiter = limiter;
  return handler;
}

/** Global limiter applied to every request. */
export function globalRateLimit(): RequestHandler {
  const c = config();
  return rateLimit({ name: 'global', max: c.RATE_LIMIT_MAX_REQUESTS, windowSeconds: c.RATE_LIMIT_WINDOW_SECONDS });
}

/** Tight limiter for credential-checking endpoints (§8: rate limit + lockout). */
export function authRateLimit(): RequestHandler {
  const c = config();
  return rateLimit({ name: 'auth', max: c.RATE_LIMIT_AUTH_MAX, windowSeconds: c.RATE_LIMIT_WINDOW_SECONDS });
}
