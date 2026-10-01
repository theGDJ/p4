import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { BASE, newApp, newSession, loginSession, readCookies, TEST_PASSWORD, uniqueEmail } from './helpers';
import { hashRefreshToken } from '../src/lib/tokens';
import { refreshTokens } from '../src/db/store';

/**
 * P1 exit gate: register -> login -> refresh -> logout works end to end.
 * Also covers feature #1: Argon2id, 15-minute JWT, rotating refresh in an
 * HttpOnly cookie, reuse detection revoking the token family, reset flow, lockout.
 */

describe('auth: registration', () => {
  let ctx = newApp();
  beforeEach(() => {
    ctx = newApp();
  });

  it('registers, hashes with argon2id, and issues a 15-minute access token', async () => {
    const email = uniqueEmail('reg');
    const res = await request(ctx.app)
      .post(`${BASE}/auth/register`)
      .send({ email, password: TEST_PASSWORD, fullName: 'Asha Verma', persona: 'MSME_MANUFACTURER' })
      .expect(201);

    expect(res.body.user.email).toBe(email.toLowerCase());
    expect(res.body.user.roles).toEqual(['USER']);
    expect(res.body.tokenType).toBe('Bearer');
    expect(res.body.expiresIn).toBe(15 * 60); // 15 minutes, feature #1
    expect(res.body.user).not.toHaveProperty('password');
    expect(res.body.user).not.toHaveProperty('passwordHash');

    const stored = ctx.store.users.rows.get(res.body.user.id)!;
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect(stored.passwordHash).not.toContain(TEST_PASSWORD);
  });

  it('sets the refresh cookie HttpOnly and Path-scoped to /auth', async () => {
    const res = await request(ctx.app)
      .post(`${BASE}/auth/register`)
      .send({ email: uniqueEmail('ck'), password: TEST_PASSWORD, fullName: 'Cookie Test' })
      .expect(201);

    const raw = (res.headers['set-cookie'] ?? []) as unknown as string[];
    const refresh = raw.find((c) => c.startsWith('bs_refresh='));
    expect(refresh).toBeDefined();
    expect(refresh).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/SameSite=Lax/i);
    // Scoped narrowly so the refresh cookie is never sent to /users, /admin, etc.
    expect(refresh).toMatch(/Path=\/api\/v1\/auth/i);

    const csrf = raw.find((c) => c.startsWith('XSRF-TOKEN='));
    expect(csrf).toBeDefined();
    expect(csrf).not.toMatch(/HttpOnly/i); // must be readable by the SPA
  });

  it('stores only a SHA-256 hash of the refresh token, never the token itself', async () => {
    const res = await request(ctx.app)
      .post(`${BASE}/auth/register`)
      .send({ email: uniqueEmail('hash'), password: TEST_PASSWORD, fullName: 'Hash Test' })
      .expect(201);
    const cookies = readCookies(res);
    const raw = cookies['bs_refresh']!;

    const rows = [...ctx.store.refreshTokens.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashRefreshToken(raw));
    expect(rows[0]!.tokenHash).not.toBe(raw);
    expect(JSON.stringify(rows[0])).not.toContain(raw);
  });

  it('rejects a duplicate email with 409', async () => {
    const email = uniqueEmail('dup');
    await request(ctx.app).post(`${BASE}/auth/register`).send({ email, password: TEST_PASSWORD, fullName: 'One' }).expect(201);
    const res = await request(ctx.app)
      .post(`${BASE}/auth/register`)
      .send({ email, password: TEST_PASSWORD, fullName: 'Two' })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('cannot be granted elevated roles from the request body', async () => {
    const res = await request(ctx.app)
      .post(`${BASE}/auth/register`)
      .send({ email: uniqueEmail('esc'), password: TEST_PASSWORD, fullName: 'Escalator', roles: ['ADMIN'], persona: 'CONSUMER' })
      .expect(201);
    expect(res.body.user.roles).toEqual(['USER']);
  });

  it('enforces the published password policy', async () => {
    for (const password of ['short1', 'alllettersonly', '1234567890', '']) {
      const res = await request(ctx.app)
        .post(`${BASE}/auth/register`)
        .send({ email: uniqueEmail('pw'), password, fullName: 'Policy Test' })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(Array.isArray(res.body.error.details)).toBe(true);
      // The rejected value must never be echoed back.
      expect(JSON.stringify(res.body)).not.toContain(password || '""');
    }
  });

  it('rejects a malformed email and an over-long one', async () => {
    await request(ctx.app)
      .post(`${BASE}/auth/register`)
      .send({ email: 'not-an-email', password: TEST_PASSWORD, fullName: 'Bad Email' })
      .expect(400);
    await request(ctx.app)
      .post(`${BASE}/auth/register`)
      .send({ email: `${'a'.repeat(250)}@b.com`, password: TEST_PASSWORD, fullName: 'Long Email' })
      .expect(400);
  });

  it('strips control characters from the display name (R6 sanitisation)', async () => {
    const res = await request(ctx.app)
      .post(`${BASE}/auth/register`)
      .send({ email: uniqueEmail('ctrl'), password: TEST_PASSWORD, fullName: 'Asha\u0000\u0007 Verma\u202E' })
      .expect(201);
    expect(res.body.user.fullName).toBe('Asha Verma');
  });
});

describe('auth: login and lockout', () => {
  it('logs in and returns a session', async () => {
    const session = await newSession({ fullName: 'Login Test' });
    const res = await loginSession(session.app, session.email, TEST_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.accessToken.length).toBeGreaterThan(50);
    expect(res.refreshToken.length).toBeGreaterThan(20);
  });

  it('returns the SAME error for an unknown email and a wrong password (no enumeration)', async () => {
    const session = await newSession();
    const wrongPassword = await loginSession(session.app, session.email, 'Wrong-Horse-99');
    const unknownEmail = await loginSession(session.app, uniqueEmail('ghost'), TEST_PASSWORD);

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    // `traceRef` is deliberately unique per request, so compare the attacker-visible
    // part only: status, code and message must be indistinguishable.
    const visible = (b: unknown) => {
      const e = (b as { error: { code: string; message: string } }).error;
      return { code: e.code, message: e.message };
    };
    expect(visible(wrongPassword.body)).toEqual(visible(unknownEmail.body));
    expect(visible(wrongPassword.body).code).toBe('INVALID_CREDENTIALS');
  });

  it('locks the account after the configured number of failures', async () => {
    const session = await newSession();
    for (let i = 0; i < 5; i += 1) {
      const res = await loginSession(session.app, session.email, `Wrong-Horse-${i}9`);
      expect(res.status).toBe(401);
    }
    const locked = await loginSession(session.app, session.email, TEST_PASSWORD);
    expect(locked.status).toBe(423);
    expect((locked.body as { error: { code: string } }).error.code).toBe('ACCOUNT_LOCKED');
  });

  it('resets the failure counter after a successful login', async () => {
    const session = await newSession();
    for (let i = 0; i < 3; i += 1) await loginSession(session.app, session.email, `Wrong-Horse-${i}9`);
    const ok = await loginSession(session.app, session.email, TEST_PASSWORD);
    expect(ok.status).toBe(200);
    expect(session.store.users.rows.get(session.userId)!.failedLoginAttempts).toBe(0);
  });
});

describe('auth: refresh rotation and reuse detection', () => {
  it('rotates the refresh token and keeps the same family', async () => {
    const session = await newSession();
    const familyBefore = refreshTokens.byHash(session.store, hashRefreshToken(session.refreshToken))!.familyId;

    const res = await request(session.app)
      .post(`${BASE}/auth/refresh`)
      .set('Cookie', [`bs_refresh=${session.refreshToken}`, `XSRF-TOKEN=${session.csrfToken}`])
      .set('X-XSRF-TOKEN', session.csrfToken)
      .expect(200);

    const cookies = readCookies(res);
    const newRefresh = cookies['bs_refresh']!;
    expect(newRefresh).toBeTruthy();
    expect(newRefresh).not.toBe(session.refreshToken);

    const oldRow = refreshTokens.byHash(session.store, hashRefreshToken(session.refreshToken))!;
    const newRow = refreshTokens.byHash(session.store, hashRefreshToken(newRefresh))!;
    expect(oldRow.usedAt).not.toBeNull();
    expect(oldRow.replacedByTokenId).toBe(newRow.id);
    expect(newRow.familyId).toBe(familyBefore);
    expect(newRow.usedAt).toBeNull();
  });

  it('REVOKES THE WHOLE FAMILY when an already-used token is replayed', async () => {
    const session = await newSession();
    const first = session.refreshToken;
    const csrf = session.csrfToken;

    // 1. legitimate rotation
    const rotated = await request(session.app)
      .post(`${BASE}/auth/refresh`)
      .set('Cookie', [`bs_refresh=${first}`, `XSRF-TOKEN=${csrf}`])
      .set('X-XSRF-TOKEN', csrf)
      .expect(200);
    const second = readCookies(rotated)['bs_refresh']!;
    const csrf2 = readCookies(rotated)['XSRF-TOKEN']!;

    // 2. attacker replays the stolen, already-rotated token
    const replay = await request(session.app)
      .post(`${BASE}/auth/refresh`)
      .set('Cookie', [`bs_refresh=${first}`, `XSRF-TOKEN=${csrf2}`])
      .set('X-XSRF-TOKEN', csrf2)
      .expect(401);
    expect(replay.body.error.code).toBe('REFRESH_REUSED');

    // 3. the legitimate newest token is now dead too — the family is burned
    const afterReplay = await request(session.app)
      .post(`${BASE}/auth/refresh`)
      .set('Cookie', [`bs_refresh=${second}`, `XSRF-TOKEN=${csrf2}`])
      .set('X-XSRF-TOKEN', csrf2)
      .expect(401);
    expect(afterReplay.body.error.code).toBe('REFRESH_REUSED');

    const familyId = refreshTokens.byHash(session.store, hashRefreshToken(first))!.familyId;
    const family = refreshTokens.byFamily(session.store, familyId);
    expect(family.length).toBeGreaterThanOrEqual(2);
    expect(family.every((t) => t.revokedAt !== null)).toBe(true);
  });

  it('rejects a fabricated refresh token', async () => {
    const session = await newSession();
    const res = await request(session.app)
      .post(`${BASE}/auth/refresh`)
      .set('Cookie', [`bs_refresh=${'x'.repeat(64)}`, `XSRF-TOKEN=${session.csrfToken}`])
      .set('X-XSRF-TOKEN', session.csrfToken)
      .expect(401);
    expect(res.body.error.code).toBe('REFRESH_REUSED');
  });

  it('requires the CSRF header because the refresh token is cookie-borne', async () => {
    const session = await newSession();
    const res = await request(session.app)
      .post(`${BASE}/auth/refresh`)
      .set('Cookie', [`bs_refresh=${session.refreshToken}`, `XSRF-TOKEN=${session.csrfToken}`])
      .expect(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('rejects a mismatched CSRF header', async () => {
    const session = await newSession();
    const res = await request(session.app)
      .post(`${BASE}/auth/refresh`)
      .set('Cookie', [`bs_refresh=${session.refreshToken}`, `XSRF-TOKEN=${session.csrfToken}`])
      .set('X-XSRF-TOKEN', 'a'.repeat(43))
      .expect(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('rejects refresh with no cookie at all', async () => {
    const session = await newSession();
    await request(session.app)
      .post(`${BASE}/auth/refresh`)
      .set('X-XSRF-TOKEN', session.csrfToken)
      .set('Cookie', [`XSRF-TOKEN=${session.csrfToken}`])
      .expect(401);
  });
});

describe('auth: logout', () => {
  it('revokes the family and clears cookies', async () => {
    const session = await newSession();
    const res = await request(session.app)
      .post(`${BASE}/auth/logout`)
      .set('Cookie', [`bs_refresh=${session.refreshToken}`, `XSRF-TOKEN=${session.csrfToken}`])
      .set('X-XSRF-TOKEN', session.csrfToken)
      .expect(204);

    const setCookies = (res.headers['set-cookie'] ?? []) as string[];
    expect(setCookies.some((c) => c.startsWith('bs_refresh=;') || /bs_refresh=;\s*Expires=Thu, 01 Jan 1970/i.test(c))).toBe(true);

    const row = refreshTokens.byHash(session.store, hashRefreshToken(session.refreshToken))!;
    expect(row.revokedAt).not.toBeNull();

    // The revoked token can no longer mint a session.
    await request(session.app)
      .post(`${BASE}/auth/refresh`)
      .set('Cookie', [`bs_refresh=${session.refreshToken}`, `XSRF-TOKEN=${session.csrfToken}`])
      .set('X-XSRF-TOKEN', session.csrfToken)
      .expect(401);
  });

  it('logout is idempotent for an unknown token', async () => {
    const session = await newSession();
    await request(session.app)
      .post(`${BASE}/auth/logout`)
      .set('Cookie', [`bs_refresh=${'y'.repeat(64)}`, `XSRF-TOKEN=${session.csrfToken}`])
      .set('X-XSRF-TOKEN', session.csrfToken)
      .expect(204);
  });
});

describe('auth: password reset', () => {
  it('returns 202 with an identical body whether or not the account exists', async () => {
    const session = await newSession();
    const known = await request(session.app)
      .post(`${BASE}/auth/password/reset-request`)
      .send({ email: session.email })
      .expect(202);
    const unknown = await request(session.app)
      .post(`${BASE}/auth/password/reset-request`)
      .send({ email: uniqueEmail('nobody') })
      .expect(202);

    expect(known.body.accepted).toBe(true);
    expect(unknown.body.accepted).toBe(true);
    expect(known.body.message).toBe(unknown.body.message);
    // The unknown-address response must not leak a dev token.
    expect(unknown.body.devToken).toBeUndefined();
  });

  it('completes the reset, revokes sessions, and lets the new password in', async () => {
    const session = await newSession();
    const requested = await request(session.app)
      .post(`${BASE}/auth/password/reset-request`)
      .send({ email: session.email })
      .expect(202);
    const token = requested.body.devToken as string;
    expect(token).toBeTruthy();

    await request(session.app)
      .post(`${BASE}/auth/password/reset`)
      .send({ token, password: 'Brand-New-Horse-7' })
      .expect(204);

    expect((await loginSession(session.app, session.email, TEST_PASSWORD)).status).toBe(401);
    expect((await loginSession(session.app, session.email, 'Brand-New-Horse-7')).status).toBe(200);

    // The pre-reset refresh token is dead.
    await request(session.app)
      .post(`${BASE}/auth/refresh`)
      .set('Cookie', [`bs_refresh=${session.refreshToken}`, `XSRF-TOKEN=${session.csrfToken}`])
      .set('X-XSRF-TOKEN', session.csrfToken)
      .expect(401);
  });

  it('rejects a reset token that has already been used', async () => {
    const session = await newSession();
    const requested = await request(session.app)
      .post(`${BASE}/auth/password/reset-request`)
      .send({ email: session.email })
      .expect(202);
    const token = requested.body.devToken as string;

    await request(session.app).post(`${BASE}/auth/password/reset`).send({ token, password: 'Brand-New-Horse-7' }).expect(204);
    const second = await request(session.app)
      .post(`${BASE}/auth/password/reset`)
      .send({ token, password: 'Another-Horse-77' })
      .expect(400);
    expect(second.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a fabricated reset token with 404', async () => {
    const session = await newSession();
    await request(session.app)
      .post(`${BASE}/auth/password/reset`)
      .send({ token: 'z'.repeat(43), password: 'Another-Horse-77' })
      .expect(404);
  });
});

describe('auth: access token handling', () => {
  it('rejects requests without a bearer token', async () => {
    const session = await newSession();
    const res = await request(session.app).get(`${BASE}/users/me`).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a tampered token', async () => {
    const session = await newSession();
    const tampered = `${session.accessToken.slice(0, -4)}AAAA`;
    await request(session.app).get(`${BASE}/users/me`).set('Authorization', `Bearer ${tampered}`).expect(401);
  });

  it('rejects a token signed with a different secret', async () => {
    const session = await newSession();
    const jwt = await import('jsonwebtoken');
    const forged = jwt.sign({ roles: ['ADMIN'] }, 'attacker-secret-that-is-long-enough-32b', {
      subject: session.userId,
      algorithm: 'HS256',
      expiresIn: '15m',
      issuer: 'bis-saathi',
      audience: 'bis-saathi-web',
    });
    await request(session.app).get(`${BASE}/users/me`).set('Authorization', `Bearer ${forged}`).expect(401);
  });

  it('rejects alg:none tokens', async () => {
    const session = await newSession();
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: session.userId, roles: ['ADMIN'] })).toString('base64url');
    await request(session.app)
      .get(`${BASE}/users/me`)
      .set('Authorization', `Bearer ${header}.${payload}.`)
      .expect(401);
  });

  it('does not trust roles from the token: a demotion applies immediately', async () => {
    const session = await newSession({ roles: ['ADMIN'] });
    await request(session.app).get(`${BASE}/admin/audit-logs`).set('Authorization', `Bearer ${session.accessToken}`).expect(200);

    // Demote in the store; the still-valid token must no longer grant access.
    session.store.users.rows.get(session.userId)!.roles = ['USER'];
    const res = await request(session.app)
      .get(`${BASE}/admin/audit-logs`)
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
