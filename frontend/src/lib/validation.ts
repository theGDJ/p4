import { z } from 'zod';

/**
 * The client-side mirror of the server schema in docs/API.md.
 *
 * Two rules about this file:
 *  1. It exists so a user is not sent a payload the API will reject. It is NOT a
 *     security control — the server is authoritative for every one of these rules, and
 *     removing this file must not change what the API accepts.
 *  2. Nothing here is allowed to be a guess about the server's policy. Length limits
 *     that the server publishes (password minimum) are *passed in* from
 *     /meta/bootstrap by the caller, with a documented fallback for the window before
 *     bootstrap resolves. A hard-coded "10" duplicated in both stacks is how a policy
 *     change silently becomes a client that rejects valid passwords.
 *
 * It is a plain function rather than a hook so it can be unit-tested without a
 * renderer: the schema, not the component, is what these limits live in.
 */

export const EMAIL_MAX = 254;
export const PASSWORD_MAX = 200;
export const NAME_MAX = 120;
export const MESSAGE_MAX = 4000;
export const TITLE_MAX = 160;
/** Used only until /meta/bootstrap resolves; the server value wins after that. */
export const PASSWORD_MIN_FALLBACK = 10;
/** docs/API.md: reset tokens are opaque and at least this long. */
export const RESET_TOKEN_MIN = 20;

/** The translation function, narrowed to the shape this module needs. */
export type Translate = (key: string) => string;

export interface SchemaOptions {
  t: Translate;
  passwordMinLength?: number;
}

export function buildAuthSchemas({ t, passwordMinLength = PASSWORD_MIN_FALLBACK }: SchemaOptions) {
  // `.trim()` before `.email()`: a pasted address usually carries a trailing space,
  // and rejecting it is user-hostile. Trimming never makes an internally malformed
  // address valid — "a b@example.org" still fails, which is the point.
  const email = (message: string) =>
    z
      .string()
      .trim()
      .min(1, message)
      .max(EMAIL_MAX, message)
      .email(message);

  // A letter and a digit, tested on Unicode properties rather than [A-Za-z]: a
  // Devanagari passphrase is a real password, and an ASCII-only class would tell a
  // Hindi user their valid secret is too weak.
  const password = z
    .string()
    .min(passwordMinLength, t('auth.errors.weakPassword'))
    .max(PASSWORD_MAX, t('auth.errors.weakPassword'))
    .refine((value) => /\p{L}/u.test(value), t('auth.passwordHint'))
    .refine((value) => /\p{N}/u.test(value), t('auth.passwordHint'));

  const validation = t('auth.errors.validation');

  return {
    email,
    password,
    login: z.object({
      // Login does not enforce the strength policy: an account created under an older,
      // weaker rule must still be able to sign in. Length is capped only to keep a
      // paste of an entire document from being sent as a credential.
      email: email(validation),
      password: z.string().min(1, validation).max(PASSWORD_MAX),
    }),
    register: z
      .object({
        // `.trim()` then `.min(1)` so "   " is rejected; the ceiling counts UTF-16
        // code units, which keeps a Devanagari name from being penalised the way a
        // byte-length check would.
        fullName: z.string().trim().min(1, validation).max(NAME_MAX, validation),
        email: email(validation),
        password,
        confirmPassword: z.string(),
        persona: z.string().optional(),
      })
      .refine((value) => value.password === value.confirmPassword, {
        path: ['confirmPassword'],
        message: t('auth.errors.passwordMismatch'),
      }),
    forgot: z.object({ email: email(validation) }),
    reset: z.object({
      token: z.string().trim().min(RESET_TOKEN_MIN, validation),
      password,
    }),
  };
}

export type AuthSchemas = ReturnType<typeof buildAuthSchemas>;

/**
 * Limits enforced as clamps rather than schemas, because the chat composer must
 * truncate rather than block: silently dropping the tail of a pasted question is
 * better than refusing to send it. Kept here so the number exists in exactly one
 * place next to its documented contract.
 */
export const LIMITS = {
  messageMax: MESSAGE_MAX,
  titleMax: TITLE_MAX,
} as const;

/** Truncates on a character boundary; a 4001-character question becomes 4000. */
export function clampLength(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** `persona` is sent as null when unset rather than "", which the enum would reject. */
export function normalizePersona(value: string | undefined | null): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}
