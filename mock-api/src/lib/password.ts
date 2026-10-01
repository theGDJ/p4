import { config } from '../config';
import { logger } from './logger';

/**
 * Password hashing: Argon2id (preferred, feature #1) with a BCrypt fallback.
 *
 * The stored hash is self-describing (`$argon2id$...` vs `$2b$...`), so
 * verification dispatches on the prefix and a hash written by either scheme
 * remains valid. Which scheme is actually active is exposed by
 * `activeScheme()` and reported in `/meta/bootstrap` — never silently assumed.
 */

type Argon2Module = {
  hash: (secret: string, opts?: Record<string, number>) => Promise<string>;
  verify: (hashed: string, secret: string) => Promise<boolean>;
};

let argon2: Argon2Module | null = null;
let argon2LoadError: string | null = null;

try {
  // Optional native dependency. If the prebuilt binary is unavailable on this
  // platform we degrade to BCrypt rather than refuse to start.
  argon2 = (await import('@node-rs/argon2')) as unknown as Argon2Module;
} catch (err) {
  argon2LoadError = err instanceof Error ? err.message : String(err);
}

interface BcryptModule {
  hash: (s: string, rounds: number) => Promise<string>;
  compare: (s: string, h: string) => Promise<string | boolean>;
}

let bcrypt: BcryptModule | null = null;
try {
  const mod = (await import('bcryptjs')) as unknown as { default?: BcryptModule } & BcryptModule;
  bcrypt = mod.default ?? mod;
} catch (err) {
  logger.error('bcryptjs unavailable; password hashing requires @node-rs/argon2', {
    err,
  });
}

const BCRYPT_ROUNDS = 12;

if (!argon2 && !bcrypt) {
  throw new Error('No password hashing implementation available (need @node-rs/argon2 or bcryptjs).');
}

if (argon2LoadError) {
  logger.warn('Argon2id unavailable, falling back to BCrypt', { reason: argon2LoadError });
}

export type PasswordScheme = 'argon2id' | 'bcrypt';

export function activeScheme(): PasswordScheme {
  return argon2 ? 'argon2id' : 'bcrypt';
}

export function hashingStatus(): { scheme: PasswordScheme; argon2LoadError: string | null } {
  return { scheme: activeScheme(), argon2LoadError };
}

export async function hashPassword(plain: string): Promise<string> {
  if (argon2) {
    const c = config();
    return argon2.hash(plain, {
      // 2 = Argon2id. Memory in KiB, per OWASP guidance mirrored in .env.example.
      type: 2,
      memoryCost: c.ARGON2_MEMORY_KIB,
      timeCost: c.ARGON2_ITERATIONS,
      parallelism: c.ARGON2_PARALLELISM,
    });
  }
  if (!bcrypt) throw new Error('No password hashing implementation available.');
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (!stored) return false;
  try {
    if (stored.startsWith('$argon2')) {
      if (!argon2) return false;
      // `await` is required: `return promise` inside try/catch does NOT route the
      // rejection through this handler, so a malformed stored hash would escape as
      // an unhandled rejection during login instead of failing closed.
      return await argon2.verify(stored, plain);
    }
    if (stored.startsWith('$2')) {
      if (!bcrypt) return false;
      return Boolean(await bcrypt.compare(plain, stored));
    }
  } catch (err) {
    // A malformed stored hash must not become a 500 that leaks internals.
    logger.warn('password verification failed on malformed hash', { err });
    return false;
  }
  return false;
}

/**
 * Reject credentials whose stored hash uses a weaker scheme than the configured
 * one, so an operator can migrate. Returns true when a rehash is warranted.
 */
export function needsRehash(stored: string): boolean {
  return activeScheme() === 'argon2id' && !stored.startsWith('$argon2');
}
