import { describe, expect, it } from 'vitest';
import {
  buildAuthSchemas,
  clampLength,
  EMAIL_MAX,
  LIMITS,
  NAME_MAX,
  normalizePersona,
  PASSWORD_MAX,
  RESET_TOKEN_MIN,
} from '@/lib/validation';

/**
 * The client-side schema, asserted against the module the forms actually use.
 *
 * These tests import `buildAuthSchemas` from `src/lib/validation.ts` — the same
 * function `src/pages/auth.tsx` feeds to `zodResolver`. They deliberately do NOT
 * redeclare a local copy of the rules: a test that builds its own schema passes
 * forever even after the app's rules change, which is worse than no test, because it
 * is green while meaningless.
 *
 * The purpose of this file is the §8 requirement that the client mirror the server
 * exactly. Each rule is checked at its boundaries — smallest legal, largest illegal —
 * because "it validates emails" is not a property a boundary reveals.
 */

const t = (key: string) => key;
const schemas = buildAuthSchemas({ t });

function register(values: Partial<Parameters<typeof schemas.register.parse>[0]>) {
  return schemas.register.safeParse({
    fullName: 'Asha Rao',
    email: 'asha@example.org',
    password: 'a123456789',
    confirmPassword: 'a123456789',
    persona: undefined,
    ...values,
  });
}

describe('email', () => {
  it('accepts a plain address and a plus-address', () => {
    expect(schemas.login.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
    expect(schemas.login.safeParse({ email: 'first.last+tag@sub.example.org', password: 'x' }).success).toBe(true);
  });

  it('rejects the shapes a naive regex lets through', () => {
    for (const bad of ['', 'no-at-sign', '@no-local.org', 'no-domain@', 'a b@example.org', 'two@@example.org', 'a@b@c.org']) {
      expect(schemas.forgot.safeParse({ email: bad }).success, `expected ${JSON.stringify(bad)} to be invalid`).toBe(false);
    }
  });

  it('trims surrounding whitespace, because a pasted address usually carries one', () => {
    const result = schemas.forgot.safeParse({ email: '  asha@example.org  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe('asha@example.org');
  });

  it('does not trim an internal space into validity', () => {
    expect(schemas.forgot.safeParse({ email: ' a b @example.org ' }).success).toBe(false);
  });

  it('enforces the 254-character ceiling from docs/API.md', () => {
    expect(EMAIL_MAX).toBe(254);
    expect(schemas.forgot.safeParse({ email: `${'a'.repeat(241)}@example.com` }).success).toBe(true);
    expect(schemas.forgot.safeParse({ email: `${'a'.repeat(243)}@example.com` }).success).toBe(false);
  });
});

describe('password — registration policy', () => {
  it('accepts exactly the documented minimum with a letter and a number', () => {
    expect(register({ password: 'a123456789', confirmPassword: 'a123456789' }).success).toBe(true);
    // One character less is rejected — the boundary, not the rule in the abstract.
    expect(register({ password: 'a12345678', confirmPassword: 'a12345678' }).success).toBe(false);
  });

  it('rejects one character below the minimum', () => {
    const result = register({ password: 'a12345678', confirmPassword: 'a12345678' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issue.path.join('.') === 'password')).toBe(true);
    // The message is a key, which the page translates: no English string in the layer.
    expect(result.error.issues.find((issue) => issue.path.join('.') === 'password')?.message).toBe(
      'auth.errors.weakPassword',
    );
  });

  it('rejects an all-letter and an all-digit password of legal length', () => {
    expect(register({ password: 'a'.repeat(12), confirmPassword: 'a'.repeat(12) }).success).toBe(false);
    expect(register({ password: '1'.repeat(12), confirmPassword: '1'.repeat(12) }).success).toBe(false);
  });

  it('accepts a Devanagari passphrase: a letter is a letter in any script', () => {
    // The backend checks Character.isLetter/isDigit for the same reason. An
    // ASCII-only class here would tell a Hindi user their correct password is too
    // weak, and the failure would be reported as a login bug.
    expect(register({ password: 'पासवर्डशब्द9', confirmPassword: 'पासवर्डशब्द9' }).success).toBe(true);
    expect(register({ password: 'केवलअंक१२३', confirmPassword: 'केवलअंक१२३' }).success).toBe(true);
  });

  it('accepts a long passphrase with spaces and rejects one with neither class', () => {
    expect(register({ password: 'correct horse battery 9', confirmPassword: 'correct horse battery 9' }).success).toBe(true);
    expect(register({ password: 'correct horse battery', confirmPassword: 'correct horse battery' }).success).toBe(false);
  });

  it('caps at 200 characters and rejects 201', () => {
    expect(PASSWORD_MAX).toBe(200);
    const at = (n: number) => `a${'b'.repeat(n - 2)}1`;
    expect(at(200)).toHaveLength(200);
    expect(at(201)).toHaveLength(201);
    expect(register({ password: at(200), confirmPassword: at(200) }).success).toBe(true);
    expect(register({ password: at(201), confirmPassword: at(201) }).success).toBe(false);
  });

  it('follows the minimum the server publishes rather than a copy of it', () => {
    // This is the drift guard: the page passes passwordMinLength from
    // /meta/bootstrap, so a server policy change moves the client rule with it.
    const stricter = buildAuthSchemas({ t, passwordMinLength: 14 });
    expect(register({ password: 'a123456789', confirmPassword: 'a123456789' }).success).toBe(true);
    expect(stricter.register.safeParse({ password: 'a123456789', confirmPassword: 'a123456789' }).success).toBe(false);
    expect(
      stricter.register.safeParse({
        fullName: 'Asha Rao',
        email: 'asha@example.org',
        password: 'a1234567890123',
        confirmPassword: 'a1234567890123',
      }).success,
    ).toBe(true);
  });

  it('login never enforces strength, so an account created under an older policy can sign in', () => {
    expect(schemas.login.safeParse({ email: 'a@b.co', password: 'short' }).success).toBe(true);
    expect(schemas.login.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false);
  });
});

describe('fullName', () => {
  it('rejects empty, whitespace-only and tab-only values', () => {
    for (const bad of ['', '   ', '\t\n']) {
      expect(register({ fullName: bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('enforces the 120-character ceiling', () => {
    expect(NAME_MAX).toBe(120);
    expect(register({ fullName: 'अ'.repeat(120) }).success).toBe(true);
    // One over the ceiling, not one under it.
    expect(`\u0905`.length).toBe(1);
    expect(register({ fullName: `${'अ'.repeat(120)}x` }).success).toBe(false);
  });

  it('counts characters, not bytes, so a Hindi name is not penalised', () => {
    const hindi = 'राजेश कुमार शर्मा'.repeat(3);
    expect(hindi.length).toBeLessThanOrEqual(120);
    expect(new TextEncoder().encode(hindi).length).toBeGreaterThan(60);
    expect(register({ fullName: hindi }).success).toBe(true);
  });
});

describe('confirmation match', () => {
  it('fails on confirmPassword, not on password, so the right control is marked', () => {
    const result = register({ confirmPassword: '012345678a' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(['confirmPassword']);
    expect(result.error.issues[0]?.message).toBe('auth.errors.passwordMismatch');
  });

  it('passes when both match and are legal', () => {
    expect(register({}).success).toBe(true);
  });
});

describe('reset token', () => {
  it('requires the documented minimum length', () => {
    expect(RESET_TOKEN_MIN).toBe(20);
    expect(schemas.reset.safeParse({ token: 'a'.repeat(20), password: 'a123456789' }).success).toBe(true);
    expect(schemas.reset.safeParse({ token: 'a'.repeat(19), password: 'a123456789' }).success).toBe(false);
  });

  it('applies the strength policy to the new password', () => {
    expect(schemas.reset.safeParse({ token: 'a'.repeat(32), password: 'weak' }).success).toBe(false);
  });
});

describe('persona handling', () => {
  it('sends null rather than an empty string, which the server enum rejects', () => {
    expect(normalizePersona('')).toBeNull();
    expect(normalizePersona('   ')).toBeNull();
    expect(normalizePersona(undefined)).toBeNull();
    expect(normalizePersona(null)).toBeNull();
    expect(normalizePersona('  CONSUMER  ')).toBe('CONSUMER');
  });

  it('accepts a persona value without knowing the enum', () => {
    // The option list comes from /meta/bootstrap, so the schema must not hard-code
    // the four values or a new persona becomes a client-side rejection.
    expect(normalizePersona('RESEARCHER')).toBe('RESEARCHER');
    expect(register({ persona: 'MSME_MANUFACTURER' }).success).toBe(true);
  });
});

describe('limits the composer clamps to', () => {
  it('match docs/API.md', () => {
    expect(LIMITS.messageMax).toBe(4000);
    expect(LIMITS.titleMax).toBe(160);
  });

  it('clampLength truncates rather than rejecting', () => {
    expect(clampLength('abc', 10)).toBe('abc');
    expect(clampLength('a'.repeat(4001), 4000)).toHaveLength(4000);
    // A boundary value is untouched: no off-by-one at the limit.
    expect(clampLength('a'.repeat(4000), 4000)).toHaveLength(4000);
  });

  it('measures a multi-byte question in characters, not bytes', () => {
    const hindi = 'जल'.repeat(2001);
    expect(new TextEncoder().encode(hindi).length).toBeGreaterThan(4000);
    // A byte-based limit would cut a Hindi question in half while an English one of
    // the same character count passed untouched.
    expect(clampLength(hindi, 4000)).toHaveLength(4000);
  });
});
