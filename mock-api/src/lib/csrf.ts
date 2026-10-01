import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config';
import { CSRF_COOKIE, CSRF_HEADER } from '../constants';
import { csrfFailed } from './errors';

/**
 * Double-submit CSRF protection (§8 "CSRF for cookie flows").
 *
 * Only the refresh token is cookie-borne, and only `/auth/refresh`, `/auth/logout`
 * and `/auth/password/*` rely on it — but those are exactly the state-changing
 * cookie flows, so they are protected. The challenge cookie is readable by JS by
 * design; the attacker's cross-origin request cannot read it, so cannot echo it.
 */

export function issueCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

export function setCsrfCookie(res: Response, token: string): void {
  const c = config();
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false, // must be readable by the SPA to echo back
    secure: c.COOKIE_SECURE,
    sameSite: c.COOKIE_SAME_SITE === 'None' ? 'none' : c.COOKIE_SAME_SITE.toLowerCase() as 'lax' | 'strict',
    path: '/',
    ...(c.COOKIE_DOMAIN ? { domain: c.COOKIE_DOMAIN } : {}),
  });
}

export function clearCsrfCookie(res: Response): void {
  const c = config();
  res.clearCookie(CSRF_COOKIE, {
    path: '/',
    secure: c.COOKIE_SECURE,
    sameSite: c.COOKIE_SAME_SITE === 'None' ? 'none' : c.COOKIE_SAME_SITE.toLowerCase() as 'lax' | 'strict',
    ...(c.COOKIE_DOMAIN ? { domain: c.COOKIE_DOMAIN } : {}),
  });
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Guard for the cookie-authenticated endpoints listed above. */
export function requireCsrf(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!config().CSRF_ENABLED) {
      next();
      return;
    }
    const cookieToken = req.cookies?.[CSRF_COOKIE];
    const headerToken = req.headers[CSRF_HEADER];
    const header = Array.isArray(headerToken) ? headerToken[0] : headerToken;

    if (typeof cookieToken !== 'string' || cookieToken.length === 0) {
      next(csrfFailed());
      return;
    }
    if (typeof header !== 'string' || header.length === 0 || !safeEqual(cookieToken, header)) {
      next(csrfFailed());
      return;
    }
    next();
  };
}
