import { createHash, randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import type { Role } from '../constants';

/**
 * Token primitives.
 *
 * - Access token: signed JWT, 15-minute TTL (feature #1), carries `sub` and `roles`.
 * - Refresh token: **opaque** random value. Only its SHA-256 hash is persisted, so a
 *   database leak does not yield usable sessions. Rotation and family-based reuse
 *   detection live in `modules/auth/refresh.ts`.
 */

export interface AccessTokenClaims {
  sub: string;
  roles: Role[];
  jti: string;
  iat: number;
  exp: number;
}

export function signAccessToken(userId: string, roles: Role[]): { token: string; jti: string; expiresAt: Date } {
  const c = config();
  const jti = randomUUID();
  const token = jwt.sign({ roles, jti }, c.JWT_ACCESS_SECRET, {
    subject: userId,
    algorithm: 'HS256',
    expiresIn: `${c.JWT_ACCESS_TTL_MINUTES}m`,
    issuer: 'bis-saathi',
    audience: 'bis-saathi-web',
  });
  const expiresAt = new Date(Date.now() + c.JWT_ACCESS_TTL_MINUTES * 60_000);
  return { token, jti, expiresAt };
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  const c = config();
  const payload = jwt.verify(token, c.JWT_ACCESS_SECRET, {
    algorithms: ['HS256'],
    issuer: 'bis-saathi',
    audience: 'bis-saathi-web',
  }) as unknown as AccessTokenClaims;
  if (typeof payload.sub !== 'string' || !Array.isArray(payload.roles)) {
    throw new jwt.JsonWebTokenError('malformed claims');
  }
  return payload;
}

/** New opaque refresh token + the hash that gets stored. */
export function issueRefreshToken(): { tokenId: string; rawToken: string; tokenHash: string; expiresAt: Date } {
  const c = config();
  const rawToken = randomBytes(48).toString('base64url');
  return {
    tokenId: randomUUID(),
    rawToken,
    tokenHash: hashRefreshToken(rawToken),
    expiresAt: new Date(Date.now() + c.JWT_REFRESH_TTL_DAYS * 86_400_000),
  };
}

export function hashRefreshToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/** The window a reset link stays valid, shared by the token and the mail wording. */
export const RESET_TOKEN_TTL_MINUTES = 30;

/** Password-reset token: opaque, single use, short-lived, stored hashed. */
export function issueResetToken(): { rawToken: string; tokenHash: string; expiresAt: Date } {
  const rawToken = randomBytes(32).toString('base64url');
  return {
    rawToken,
    tokenHash: createHash('sha256').update(rawToken).digest('hex'),
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60_000),
  };
}

export function newFamilyId(): string {
  return randomUUID();
}
