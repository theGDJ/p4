import { Router, type Response } from 'express';
import type { CookieOptions } from 'express';
import { config } from '../../config';
import { REFRESH_COOKIE } from '../../constants';
import type { Store } from '../../db/store';
import { recordAudit, AUDIT_ACTIONS } from '../../lib/audit';
import { clearCsrfCookie, issueCsrfToken, requireCsrf, setCsrfCookie } from '../../lib/csrf';
import { unauthenticated } from '../../lib/errors';
import { authRateLimit, clientIp } from '../../lib/rateLimit';
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  resetConfirmSchema,
  resetRequestSchema,
  validateBody,
} from '../../lib/validate';
import { authenticate, type AuthenticatedRequest } from '../../security/middleware';
import {
  changePassword,
  login,
  logout,
  publicUser,
  register,
  requestPasswordReset,
  resetPassword,
  rotateRefreshToken,
  type SessionIssued,
} from './service';

/**
 * Auth routes (feature #1). See docs/API.md for the published contract.
 */

function refreshCookieOptions(): CookieOptions {
  const c = config();
  const sameSite = c.COOKIE_SAME_SITE === 'None' ? 'none' : (c.COOKIE_SAME_SITE.toLowerCase() as 'lax' | 'strict');
  return {
    httpOnly: true,
    secure: c.COOKIE_SECURE,
    sameSite,
    // Scoped to the auth endpoints only: the refresh cookie is never sent to
    // /chat, /users or /admin, shrinking the blast radius of any XSS elsewhere.
    path: `${c.API_BASE_PATH}/auth`,
    maxAge: c.JWT_REFRESH_TTL_DAYS * 86_400_000,
    ...(c.COOKIE_DOMAIN ? { domain: c.COOKIE_DOMAIN } : {}),
  };
}

function sessionPayload(s: SessionIssued) {
  return {
    user: publicUser(s.user),
    accessToken: s.accessToken,
    accessExpiresAt: s.accessExpiresAt.toISOString(),
    tokenType: 'Bearer' as const,
    expiresIn: config().JWT_ACCESS_TTL_MINUTES * 60,
  };
}

function applySession(res: Response, s: SessionIssued): void {
  res.cookie(REFRESH_COOKIE, s.refreshToken, refreshCookieOptions());
  // Rotate the CSRF challenge with the session so a pre-login token cannot be
  // replayed after authentication.
  setCsrfCookie(res, issueCsrfToken());
  // Tokens must never be cached by a browser or intermediary.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function clearSession(res: Response): void {
  // Attributes must match those used when the cookie was set, or it will not clear.
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined });
  clearCsrfCookie(res);
}

export function authRouter(store: Store): Router {
  const router = Router();
  const authed = authenticate(store);

  router.post('/register', authRateLimit(), validateBody(registerSchema), async (req, res) => {
    const s = await register(store, req.body);
    applySession(res, s);
    recordAudit(store, {
      actorUserId: s.user.id,
      actorRoles: s.user.roles,
      action: AUDIT_ACTIONS.AUTH_REGISTER,
      entityType: 'user',
      entityId: s.user.id,
      ip: clientIp(req),
    });
    res.status(201).json(sessionPayload(s));
  });

  router.post('/login', authRateLimit(), validateBody(loginSchema), async (req, res) => {
    const emailForAudit = String(req.body.email ?? '');
    try {
      const s = await login(store, { ...req.body, userAgent: req.headers['user-agent'] ?? null });
      applySession(res, s);
      recordAudit(store, {
        actorUserId: s.user.id,
        actorRoles: s.user.roles,
        action: AUDIT_ACTIONS.AUTH_LOGIN_OK,
        entityType: 'user',
        entityId: s.user.id,
        ip: clientIp(req),
      });
      res.status(200).json(sessionPayload(s));
    } catch (err) {
      recordAudit(store, {
        actorUserId: null,
        action: (err as { code?: string })?.code === 'ACCOUNT_LOCKED' ? AUDIT_ACTIONS.AUTH_LOCKOUT : AUDIT_ACTIONS.AUTH_LOGIN_FAIL,
        entityType: 'user',
        entityId: emailForAudit,
        outcome: 'FAILURE',
        ip: clientIp(req),
        metadata: { code: (err as { code?: string })?.code },
      });
      throw err;
    }
  });

  /**
   * Rotating refresh. Protected by CSRF because the refresh token is cookie-borne.
   * Replay of a used token revokes the whole family (see service.rotateRefreshToken).
   */
  router.post('/refresh', requireCsrf(), authRateLimit(), (req, res) => {
    const raw = req.cookies?.[REFRESH_COOKIE];
    if (typeof raw !== 'string' || raw.length === 0) throw unauthenticated('No refresh token present.');
    try {
      const s = rotateRefreshToken(store, raw, req.headers['user-agent'] ?? null);
      applySession(res, s);
      recordAudit(store, {
        actorUserId: s.user.id,
        actorRoles: s.user.roles,
        action: AUDIT_ACTIONS.AUTH_REFRESH,
        entityType: 'refresh_token_family',
        entityId: s.familyId,
        ip: clientIp(req),
      });
      res.status(200).json(sessionPayload(s));
    } catch (err) {
      if ((err as { code?: string })?.code === 'REFRESH_REUSED') {
        clearSession(res);
        recordAudit(store, {
          actorUserId: null,
          action: AUDIT_ACTIONS.AUTH_REFRESH_REUSE,
          entityType: 'refresh_token_family',
          outcome: 'FAILURE',
          ip: clientIp(req),
        });
      }
      throw err;
    }
  });

  router.post('/logout', requireCsrf(), (req, res) => {
    const raw = req.cookies?.[REFRESH_COOKIE];
    const result = logout(store, typeof raw === 'string' ? raw : undefined);
    clearSession(res);
    recordAudit(store, {
      actorUserId: null,
      action: AUDIT_ACTIONS.AUTH_LOGOUT,
      entityType: 'refresh_token_family',
      entityId: result.familyId,
      ip: clientIp(req),
      metadata: { tokensRevoked: result.revoked },
    });
    res.status(204).end();
  });

  /** Always 202 with an identical body — no account enumeration. */
  router.post('/password/reset-request', authRateLimit(), validateBody(resetRequestSchema), (req, res) => {
    const result = requestPasswordReset(store, req.body.email);
    recordAudit(store, {
      actorUserId: null,
      action: AUDIT_ACTIONS.AUTH_PASSWORD_RESET_REQUESTED,
      entityType: 'user',
      outcome: 'SUCCESS',
      ip: clientIp(req),
    });
    res.status(202).json({
      accepted: result.accepted,
      message: 'If an account exists for that email, a reset link is on its way.',
      // Development affordance only; `config()` refuses to boot in production with
      // insecure settings and this field is never populated there.
      ...(result.devToken ? { devToken: result.devToken } : {}),
    });
  });

  router.post('/password/reset', authRateLimit(), validateBody(resetConfirmSchema), async (req, res) => {
    await resetPassword(store, req.body.token, req.body.password);
    clearSession(res);
    res.status(204).end();
  });

  /** Change password for the signed-in user; invalidates all other sessions. */
  router.post('/password/change', authed, validateBody(changePasswordSchema), async (req, res) => {
    const r = req as AuthenticatedRequest;
    await changePassword(store, r.user!.id, req.body.currentPassword, req.body.newPassword);
    clearSession(res);
    recordAudit(store, {
      actorUserId: r.user!.id,
      actorRoles: r.user!.roles,
      action: AUDIT_ACTIONS.AUTH_PASSWORD_CHANGED,
      entityType: 'user',
      entityId: r.user!.id,
      ip: clientIp(req),
    });
    res.status(204).end();
  });

  return router;
}
