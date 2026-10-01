import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ROLE_IMPLIES, type Role } from '../constants';
import type { UserRow } from '../db/store';
import { forbidden, newTraceRef, unauthenticated } from '../lib/errors';
import { logger } from '../lib/logger';
import { verifyAccessToken } from '../lib/tokens';
import { AUDIT_ACTIONS, recordAudit } from '../lib/audit';
import { clientIp } from '../lib/rateLimit';
import type { Store } from '../db/store';

/**
 * Authentication and authorisation middleware.
 *
 * Mirrors the Spring Security chain in `backend/`: bearer JWT -> principal ->
 * method-level role check. Role checks are always server-side; anything the
 * frontend does is cosmetic (master spec §4).
 */

export interface AuthenticatedRequest extends Request {
  traceRef: string;
  store: Store;
  user?: UserRow;
  claims?: { sub: string; roles: Role[]; jti: string };
}

/** Attaches a correlation id and the store handle used by every downstream handler. */
export function requestContext(store: Store): RequestHandler {
  return (req, _res, next) => {
    const r = req as AuthenticatedRequest;
    r.traceRef = newTraceRef();
    r.store = store;
    _res.setHeader('X-Trace-Ref', r.traceRef);
    next();
  };
}

/** Rejects the request unless a valid access token is present. */
export function authenticate(store: Store): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const r = req as AuthenticatedRequest;
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) {
      next(unauthenticated());
      return;
    }
    const raw = header.slice(7).trim();
    if (raw.length === 0) {
      next(unauthenticated());
      return;
    }

    let claims: { sub: string; roles: Role[]; jti: string };
    try {
      claims = verifyAccessToken(raw);
    } catch (err) {
      const reason =
        err instanceof jwt.TokenExpiredError
          ? 'expired'
          : err instanceof jwt.JsonWebTokenError
            ? 'invalid'
            : 'invalid';
      logger.warn('access token rejected', { reason, path: req.path });
      next(unauthenticated(reason === 'expired' ? 'Session expired. Please refresh or sign in again.' : 'Invalid session.'));
      return;
    }

    // Roles in the token are advisory only: authority is re-read from the store so a
    // demotion takes effect immediately instead of at token expiry.
    const user = store.users.rows.get(claims.sub);
    if (!user) {
      next(unauthenticated('Account no longer exists.'));
      return;
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      next(forbidden('This account is temporarily locked.'));
      return;
    }

    r.user = user;
    r.claims = { sub: user.id, roles: user.roles, jti: claims.jti };
    next();
  };
}

/**
 * Requires that the caller holds `minimum` (or a role that implies it).
 * Denials are audited — a 403 on an admin route is a security event (§8).
 */
export function requireRole(store: Store, minimum: Role): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const r = req as AuthenticatedRequest;
    const user = r.user;
    if (!user) {
      next(unauthenticated());
      return;
    }
    const allowed = minimum === 'USER' || user.roles.some((role) => ROLE_IMPLIES[role].includes(minimum));
    if (!allowed) {
      recordAudit(store, {
        actorUserId: user.id,
        actorRoles: user.roles,
        action: AUDIT_ACTIONS.ADMIN_ACCESS_DENIED,
        entityType: 'endpoint',
        entityId: `${req.method} ${req.path}`,
        outcome: 'DENIED',
        ip: clientIp(req),
        metadata: { requiredRole: minimum },
      });
      next(forbidden(`Requires the ${minimum} role.`));
      return;
    }
    next();
  };
}

/** Convenience composition for admin routes. */
export function adminOnly(store: Store, minimum: Role = 'ADMIN'): RequestHandler[] {
  return [authenticate(store), requireRole(store, minimum)];
}
