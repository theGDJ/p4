import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { BASE, newApp, newSession, uniqueEmail, TEST_PASSWORD } from './helpers';
import { redactString, redactValue } from '../src/lib/logger';
import { errorHandler, rateLimited } from '../src/lib/errors';
import { detectPii, redactPii } from '../src/rag/guard';
import { activeScheme, hashPassword, verifyPassword } from '../src/lib/password';

/**
 * §8 security suite for the parts that are testable in P1.
 * Every item below is one of the enumerated §8 requirements.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('§8 security headers', () => {
  it('sets the standard hardening headers', async () => {
    const { app } = newApp();
    const res = await request(app).get(`${BASE}/health/live`).expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options'] ?? res.headers['content-security-policy']).toBeTruthy();
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(res.headers['referrer-policy']).toBeTruthy();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('exposes a correlation id on every response', async () => {
    const { app } = newApp();
    const res = await request(app).get(`${BASE}/health/live`).expect(200);
    expect(res.headers['x-trace-ref']).toMatch(/^req_/);
  });
});

describe('§8 safe error bodies', () => {
  it('never leaks a stack trace or internal detail on a 500', () => {
    // Unit-testing the handler directly: registering a route after `createApp`
    // would sit behind the 404 middleware and never run.
    const boom = new Error('connection string was jdbc:postgresql://internal-host:5432/db password=hunter2');
    let captured: { status?: number; body?: unknown } = {};
    const req = { path: '/api/v1/x', method: 'GET', traceRef: 'req_test1' } as unknown as Parameters<typeof errorHandler>[1];
    const res = {
      setHeader: () => undefined,
      status(code: number) {
        captured.status = code;
        return this;
      },
      json(body: unknown) {
        captured.body = body;
        return this;
      },
    } as unknown as Parameters<typeof errorHandler>[2];

    errorHandler(boom, req, res, () => undefined);

    expect(captured.status).toBe(500);
    const body = JSON.stringify(captured.body);
    expect((captured.body as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('internal-host');
    expect(body).not.toContain('jdbc:');
    expect(body).not.toMatch(/\bat .*\)/);
    expect(body).toContain('req_test1');
  });

  it('maps AppError status and code straight through', () => {
    let captured: { status?: number; body?: unknown } = {};
    const res = {
      setHeader: () => undefined,
      status(code: number) {
        captured.status = code;
        return this;
      },
      json(body: unknown) {
        captured.body = body;
        return this;
      },
    } as unknown as Parameters<typeof errorHandler>[2];
    const req = { path: '/x', method: 'GET', traceRef: 'req_test2' } as unknown as Parameters<typeof errorHandler>[1];

    errorHandler(rateLimited(42), req, res, () => undefined);
    expect(captured.status).toBe(429);
    expect((captured.body as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });

  it('uses one consistent error shape for every failure class', async () => {
    const { app } = newApp();
    const notFound = await request(app).get(`${BASE}/definitely-not-a-route`).expect(404);
    expect(notFound.body.error).toMatchObject({
      code: 'NOT_FOUND',
      message: expect.any(String),
      traceRef: expect.any(String),
    });

    const unauth = await request(app).get(`${BASE}/users/me`).expect(401);
    expect(unauth.body.error).toMatchObject({
      code: 'UNAUTHENTICATED',
      message: expect.any(String),
      traceRef: expect.any(String),
    });
  });

  it('rejects malformed JSON with 400, not a 500', async () => {
    const { app } = newApp();
    const res = await request(app)
      .post(`${BASE}/auth/login`)
      .set('Content-Type', 'application/json')
      .send('{"email": broken')
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('never returns a password or hash in any response', async () => {
    const session = await newSession();
    const responses = [
      await request(session.app).get(`${BASE}/users/me`).set('Authorization', `Bearer ${session.accessToken}`).expect(200),
      await request(session.app).get(`${BASE}/conversations`).set('Authorization', `Bearer ${session.accessToken}`).expect(200),
      await request(session.app).get(`${BASE}/meta/bootstrap`).expect(200),
    ];
    for (const res of responses) {
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/\$argon2id\$/);
      expect(body).not.toContain(TEST_PASSWORD);
      expect(body).not.toMatch(/passwordHash/i);
    }
  });
});

describe('§8 rate limiting and lockout', () => {
  it('returns 429 with Retry-After once the auth limit is exceeded', async () => {
    const { app } = newApp();
    const email = uniqueEmail('rl');
    let limited = 0;
    for (let i = 0; i < 14; i += 1) {
      const res = await request(app).post(`${BASE}/auth/login`).send({ email, password: 'Nope-Nope-99' });
      if (res.status === 429) {
        limited += 1;
        expect(res.body.error.code).toBe('RATE_LIMITED');
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
        break;
      }
    }
    expect(limited).toBe(1);
  });

  it('publishes rate-limit accounting headers', async () => {
    const { app } = newApp();
    const res = await request(app).get(`${BASE}/health/live`).expect(200);
    expect(res.headers['x-ratelimit-limit']).toBeTruthy();
    expect(res.headers['x-ratelimit-remaining']).toBeTruthy();
  });

  it('locks an account after repeated failures and reports 423', async () => {
    const session = await newSession();
    for (let i = 0; i < 5; i += 1) {
      await request(session.app).post(`${BASE}/auth/login`).send({ email: session.email, password: `Bad-Horse-${i}9` });
    }
    const res = await request(session.app).post(`${BASE}/auth/login`).send({ email: session.email, password: TEST_PASSWORD });
    expect(res.status).toBe(423);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('§8 input validation and size limits', () => {
  it('rejects a body larger than the configured limit with 413', async () => {
    const { app } = newApp();
    const res = await request(app)
      .post(`${BASE}/auth/register`)
      .set('Content-Type', 'application/json')
      .send({ email: uniqueEmail('big'), password: TEST_PASSWORD, fullName: 'x'.repeat(200_000) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects an over-long display name at the schema level', async () => {
    const { app } = newApp();
    await request(app)
      .post(`${BASE}/auth/register`)
      .send({ email: uniqueEmail('long'), password: TEST_PASSWORD, fullName: 'y'.repeat(121) })
      .expect(400);
  });

  it('rejects an unknown language code', async () => {
    const { app } = newApp();
    await request(app)
      .post(`${BASE}/auth/register`)
      .send({ email: uniqueEmail('lang'), password: TEST_PASSWORD, fullName: 'Lang Test', language: 'fr' })
      .expect(400);
  });
});

describe('§8 CORS allowlist', () => {
  it('allows a listed origin with credentials', async () => {
    const { app } = newApp();
    const res = await request(app).get(`${BASE}/health/live`).set('Origin', 'http://localhost:5173').expect(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('rejects an unlisted origin', async () => {
    const { app } = newApp();
    const res = await request(app).get(`${BASE}/health/live`).set('Origin', 'https://evil.example.test');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not echo an arbitrary origin', async () => {
    const { app } = newApp();
    const res = await request(app).get(`${BASE}/health/live`).set('Origin', 'null');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('§8 no secrets or PII in logs', () => {
  it('redacts emails, phones, ids, JWTs and secrets from log strings', () => {
    const input =
      'user asha.verma@example.com phone 9876543210 aadhaar 1234 5678 9012 pan ABCDE1234F token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij0123456789 password=hunter2';
    const out = redactString(input);
    expect(out).not.toContain('asha.verma@example.com');
    expect(out).not.toContain('9876543210');
    expect(out).not.toContain('1234 5678 9012');
    expect(out).not.toContain('ABCDE1234F');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).toContain('[REDACTED]');
  });

  it('blocks password-shaped keys entirely in structured logs', () => {
    const redacted = redactValue({
      email: 'a@example.test',
      password: 'hunter2',
      accessToken: 'secret-value',
      authorization: 'Bearer abc',
      nested: { refreshToken: 'xyz', apiKey: 'k' },
      keep: 'visible',
    }) as Record<string, unknown>;
    expect(JSON.stringify(redacted)).not.toContain('hunter2');
    expect(JSON.stringify(redacted)).not.toContain('secret-value');
    expect(JSON.stringify(redacted)).not.toContain('Bearer abc');
    expect(JSON.stringify(redacted)).not.toContain('xyz');
    expect(redacted.keep).toBe('visible');
  });

  it('redacts PII from a query before it is stored', () => {
    const q = 'My email is a@b.com and phone 9876543210; which standard for gold?';
    expect(detectPii(q).length).toBeGreaterThan(0);
    const clean = redactPii(q);
    expect(clean).not.toContain('a@b.com');
    expect(clean).not.toContain('9876543210');
    expect(clean).toContain('gold');
  });
});

describe('§8 password hashing', () => {
  it('uses argon2id (or a documented fallback) and never stores plaintext', async () => {
    const scheme = activeScheme();
    expect(['argon2id', 'bcrypt']).toContain(scheme);
    const hash = await hashPassword(TEST_PASSWORD);
    expect(hash).not.toContain(TEST_PASSWORD);
    expect(hash.startsWith('$argon2id$') || hash.startsWith('$2')).toBe(true);
    expect(await verifyPassword(TEST_PASSWORD, hash)).toBe(true);
    expect(await verifyPassword('Wrong-Horse-99', hash)).toBe(false);
  });

  it('produces a different hash for the same password (salted)', async () => {
    const a = await hashPassword(TEST_PASSWORD);
    const b = await hashPassword(TEST_PASSWORD);
    expect(a).not.toBe(b);
  });

  it('fails closed on a malformed stored hash', async () => {
    expect(await verifyPassword(TEST_PASSWORD, 'not-a-hash')).toBe(false);
    expect(await verifyPassword(TEST_PASSWORD, '$argon2id$broken')).toBe(false);
  });
});
