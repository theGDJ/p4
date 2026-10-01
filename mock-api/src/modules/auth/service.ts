import { createHash, randomUUID } from 'node:crypto';
import { config } from '../../config';
import type { Persona, Language } from '../../constants';
import {
  passwordResets,
  refreshTokens,
  users,
  type PasswordResetRow,
  type RefreshTokenRow,
  type Store,
  type UserRow,
} from '../../db/store';
import {
  accountLocked,
  conflict,
  invalidCredentials,
  notFound,
  refreshReused,
  badRequest,
} from '../../lib/errors';
import { hashPassword, needsRehash, verifyPassword } from '../../lib/password';
import { hashRefreshToken, issueRefreshToken, issueResetToken, newFamilyId, signAccessToken } from '../../lib/tokens';
import { logger } from '../../lib/logger';

/**
 * Authentication service (feature #1).
 *
 * Implements: registration, login with lockout, refresh-token rotation with
 * family-level reuse detection, logout, and password reset.
 *
 * Threat model notes:
 * - Unknown email and wrong password produce the SAME error (no enumeration).
 * - A replayed refresh token revokes the entire family: an attacker replaying a
 *   stolen (already rotated) token locks out both parties, which is the
 *   detectable outcome we want.
 * - Timing: we always run a hash comparison, even for an unknown email, so
 *   response time does not reveal whether an account exists.
 */

/** Constant-work dummy hash used to equalise timing on unknown-email logins. */
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export interface SessionIssued {
  user: UserRow;
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
  familyId: string;
  tokenId: string;
}

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    persona: u.persona,
    language: u.language,
    roles: u.roles,
    emailVerified: u.emailVerified,
    createdAt: u.createdAt.toISOString(),
  };
}
export type PublicUser = ReturnType<typeof publicUser>;

export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
  persona?: Persona | null;
  language?: Language;
}

export async function register(store: Store, input: RegisterInput): Promise<SessionIssued> {
  const email = input.email.trim().toLowerCase();
  if (users.byEmail(store, email)) {
    throw conflict('An account with this email already exists.');
  }

  const now = new Date();
  const user: UserRow = {
    id: randomUUID(),
    email,
    passwordHash: await hashPassword(input.password),
    fullName: input.fullName,
    persona: input.persona ?? null,
    language: input.language ?? 'en',
    // Self-registration always yields USER. Elevated roles are granted only by an
    // ADMIN through the admin surface — never from a request body.
    roles: ['USER'],
    emailVerified: false,
    failedLoginAttempts: 0,
    lockedUntil: null,
    createdAt: now,
    updatedAt: now,
  };
  users.put(store, user);
  logger.info('user registered', { userId: user.id });
  return issueSession(store, user);
}

export interface LoginInput {
  email: string;
  password: string;
  userAgent?: string | null;
}

export async function login(store: Store, input: LoginInput): Promise<SessionIssued> {
  const c = config();
  const email = input.email.trim().toLowerCase();
  const existing = users.byEmail(store, email);

  // Lockout check happens before credential verification.
  if (existing?.lockedUntil && existing.lockedUntil.getTime() > Date.now()) {
    const retryAfter = Math.ceil((existing.lockedUntil.getTime() - Date.now()) / 1000);
    throw accountLocked(retryAfter);
  }

  const hashToCheck = existing?.passwordHash ?? DUMMY_HASH;
  const passwordOk = await verifyPassword(input.password, hashToCheck);

  if (!existing || !passwordOk) {
    if (existing) {
      existing.failedLoginAttempts += 1;
      existing.updatedAt = new Date();
      if (existing.failedLoginAttempts >= c.LOGIN_MAX_FAILED_ATTEMPTS) {
        existing.lockedUntil = new Date(Date.now() + c.LOGIN_LOCKOUT_MINUTES * 60_000);
        existing.failedLoginAttempts = 0;
        logger.warn('account locked after repeated failures', { userId: existing.id });
      }
    }
    throw invalidCredentials();
  }

  if (existing.lockedUntil && existing.lockedUntil.getTime() <= Date.now()) {
    existing.lockedUntil = null;
  }
  existing.failedLoginAttempts = 0;
  existing.updatedAt = new Date();

  // Opportunistic upgrade to the stronger scheme when config changes.
  if (needsRehash(existing.passwordHash)) {
    existing.passwordHash = await hashPassword(input.password);
  }

  return issueSession(store, existing, { userAgent: input.userAgent ?? null });
}

/**
 * Creates a refresh token and returns both tokens.
 *
 * `familyId` omitted => start a NEW family (login/register).
 * `familyId` supplied => continue that family (rotation).
 *
 * Options are named, not positional: an earlier revision took `familyId` as the
 * third positional argument and a caller passed the user-agent into that slot,
 * which silently merged unrelated sessions into one revocation family.
 */
interface IssueSessionOptions {
  familyId?: string | null;
  userAgent?: string | null;
}

function issueSession(store: Store, user: UserRow, opts: IssueSessionOptions = {}): SessionIssued {
  const access = signAccessToken(user.id, user.roles);
  const refresh = issueRefreshToken();
  const family = opts.familyId ?? newFamilyId();
  const userAgent = opts.userAgent ?? null;

  const row: RefreshTokenRow = {
    id: refresh.tokenId,
    userId: user.id,
    familyId: family,
    tokenHash: refresh.tokenHash,
    expiresAt: refresh.expiresAt,
    usedAt: null,
    revokedAt: null,
    replacedByTokenId: null,
    userAgent,
    createdAt: new Date(),
  };
  refreshTokens.put(store, row);

  return {
    user,
    accessToken: access.token,
    accessExpiresAt: access.expiresAt,
    refreshToken: refresh.rawToken,
    refreshExpiresAt: refresh.expiresAt,
    familyId: family,
    tokenId: refresh.tokenId,
  };
}

/**
 * Rotates a refresh token.
 *
 * Outcomes:
 * - valid & unused  -> marked used, successor issued in the same family
 * - already used    -> **reuse detected**: whole family revoked, 401 REFRESH_REUSED
 * - revoked         -> 401 REFRESH_REUSED (family already burned)
 * - unknown/expired -> 401 REFRESH_REUSED (same public shape; no oracle)
 */
export function rotateRefreshToken(store: Store, rawToken: string, userAgent: string | null): SessionIssued {
  if (!rawToken || rawToken.length < 20) throw refreshReused();

  const hash = hashRefreshToken(rawToken);
  const row = refreshTokens.byHash(store, hash);
  if (!row) {
    logger.warn('refresh token not recognised');
    throw refreshReused();
  }

  const user = users.byId(store, row.userId);
  if (!user) throw refreshReused();

  if (row.revokedAt !== null) {
    logger.warn('rejected revoked refresh token', { familyId: row.familyId });
    throw refreshReused();
  }

  if (row.usedAt !== null) {
    // Replay of an already-rotated token. Burn the family.
    const revoked = refreshTokens.revokeFamily(store, row.familyId);
    logger.error('refresh token reuse detected; family revoked', {
      familyId: row.familyId,
      userId: user.id,
      tokensRevoked: revoked,
    });
    throw refreshReused();
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    row.revokedAt = new Date();
    throw refreshReused();
  }

  row.usedAt = new Date();

  const next = issueSession(store, user, { familyId: row.familyId, userAgent });
  row.replacedByTokenId = next.tokenId;
  return next;
}

export function logout(store: Store, rawToken: string | undefined): { revoked: number; familyId: string | null } {
  if (!rawToken) return { revoked: 0, familyId: null };
  const row = refreshTokens.byHash(store, hashRefreshToken(rawToken));
  if (!row) return { revoked: 0, familyId: null };
  const revoked = refreshTokens.revokeFamily(store, row.familyId);
  return { revoked, familyId: row.familyId };
}

export function logoutEverywhere(store: Store, userId: string): number {
  return refreshTokens.revokeAllForUser(store, userId);
}

/**
 * Requests a password reset.
 *
 * Always resolves the same way whether or not the account exists — the response
 * must not become an account-enumeration oracle. In development the token is
 * returned as `devToken` so the flow can be exercised without an email provider;
 * that field is never present when NODE_ENV=production.
 */
export function requestPasswordReset(
  store: Store,
  email: string,
): { accepted: true; devToken?: string } {
  const user = users.byEmail(store, email.trim().toLowerCase());
  if (!user) return { accepted: true };

  // Invalidate previous links so only the newest works.
  passwordResets.invalidateForUser(store, user.id);
  const issued = issueResetToken();
  const row: PasswordResetRow = {
    id: randomUUID(),
    userId: user.id,
    tokenHash: issued.tokenHash,
    expiresAt: issued.expiresAt,
    usedAt: null,
    createdAt: new Date(),
  };
  passwordResets.put(store, row);

  const c = config();
  if (c.NODE_ENV === 'production') {
    // In production this goes to the email provider; nothing is returned or logged.
    return { accepted: true };
  }
  logger.warn('dev-only password reset token issued (email delivery is not configured)', {
    userId: user.id,
  });
  return { accepted: true, devToken: issued.rawToken };
}

export async function resetPassword(store: Store, token: string, newPassword: string): Promise<void> {
  const row = passwordResets.byHash(store, hashToken(token));
  if (!row) throw notFound('Reset link');
  if (row.usedAt !== null) throw badRequest('This reset link has already been used.');
  if (row.expiresAt.getTime() <= Date.now()) throw badRequest('This reset link has expired.');

  const user = users.byId(store, row.userId);
  if (!user) throw notFound('Reset link');

  user.passwordHash = await hashPassword(newPassword);
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  user.updatedAt = new Date();
  row.usedAt = new Date();

  // A password change invalidates every existing session.
  const revoked = refreshTokens.revokeAllForUser(store, user.id);
  logger.info('password reset completed', { userId: user.id, sessionsRevoked: revoked });
}

function hashToken(raw: string): string {
  // Kept separate from hashRefreshToken for clarity; identical algorithm.
  return createHash('sha256').update(raw).digest('hex');
}

export async function changePassword(store: Store, userId: string, currentPassword: string, newPassword: string): Promise<void> {
  const user = users.byId(store, userId);
  if (!user) throw notFound('Account');
  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) throw invalidCredentials();
  user.passwordHash = await hashPassword(newPassword);
  user.updatedAt = new Date();
  refreshTokens.revokeAllForUser(store, user.id);
}

export function updateProfile(
  store: Store,
  userId: string,
  patch: { fullName?: string; persona?: Persona | null; language?: Language },
): UserRow {
  const user = users.byId(store, userId);
  if (!user) throw notFound('Account');
  if (patch.fullName !== undefined) user.fullName = patch.fullName;
  if (patch.persona !== undefined) user.persona = patch.persona;
  if (patch.language !== undefined) user.language = patch.language;
  user.updatedAt = new Date();
  return user;
}
