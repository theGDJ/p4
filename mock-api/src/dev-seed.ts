import { randomBytes } from 'node:crypto';
import { config } from './config';
import { db, users, type UserRow } from './db/store';
import { hashPassword } from './lib/password';
import { logger } from './lib/logger';
import type { Persona, Role } from './constants';

/**
 * Development seed.
 *
 * Disabled unless `SEED_DEMO_USERS=true` AND `NODE_ENV=development`. Passwords are
 * generated at boot and printed once to stdout — nothing is hardcoded, so no
 * credential ever lands in the repository, and no secret passes through the
 * redacting JSON logger.
 *
 * These accounts exist so role-gated surfaces can actually be opened in a local
 * preview. They are not sample data for the knowledge base (R10) and hold no
 * fabricated standards content.
 */

interface SeedSpec {
  email: string;
  fullName: string;
  roles: Role[];
  persona: Persona | null;
  language: 'en' | 'hi';
}

const SPECS: SeedSpec[] = [
  {
    email: 'demo.user@bissaathi.local',
    fullName: 'Demo User',
    roles: ['USER'],
    persona: 'MSME_MANUFACTURER',
    language: 'en',
  },
  {
    email: 'demo.manager@bissaathi.local',
    fullName: 'Demo Content Manager',
    roles: ['CONTENT_MANAGER'],
    persona: null,
    language: 'en',
  },
  {
    email: 'demo.admin@bissaathi.local',
    fullName: 'Demo Administrator',
    roles: ['ADMIN'],
    persona: null,
    language: 'en',
  },
];

export interface SeededAccount extends SeedSpec {
  password: string;
}

export async function seedDemoUsers(store = db()): Promise<SeededAccount[]> {
  const c = config();
  if (c.NODE_ENV !== 'development' || process.env.SEED_DEMO_USERS !== 'true') {
    return [];
  }

  const seeded: SeededAccount[] = [];
  for (const spec of SPECS) {
    if (users.byEmail(store, spec.email)) continue;
    // A fixed password may be supplied via SEED_DEMO_PASSWORD so that local smoke
    // tests and the dev preview have stable credentials across restarts. It is
    // read from the environment only, gated on development mode, and never
    // committed. Without it, passwords are random per boot.
    const configured = process.env.SEED_DEMO_PASSWORD;
    const password =
      configured && configured.length >= 10 ? configured : `Demo-${randomBytes(6).toString('base64url')}`;
    const now = new Date();
    const row: UserRow = {
      id: `seed-${spec.roles[0]!.toLowerCase()}-${now.getTime()}`,
      email: spec.email,
      passwordHash: await hashPassword(password),
      fullName: spec.fullName,
      persona: spec.persona,
      language: spec.language,
      roles: spec.roles,
      emailVerified: true,
      failedLoginAttempts: 0,
      lockedUntil: null,
      createdAt: now,
      updatedAt: now,
    };
    users.put(store, row);
    seeded.push({ ...spec, password });
  }

  if (seeded.length > 0) {
    // Deliberately stdout, not the logger: the logger redacts password-shaped keys,
    // and a dev banner must be readable by the person running the server.
    process.stdout.write('\n');
    process.stdout.write('┌─ DEV SEED ACCOUNTS (SEED_DEMO_USERS=true, development only) ─────────────┐\n');
    for (const a of seeded) {
      process.stdout.write(`│  ${a.roles.join('+').padEnd(22)} ${a.email.padEnd(32)} ${a.password}\n`);
    }
    process.stdout.write('│  These credentials are generated at boot and are not stored in the repo.  │\n');
    process.stdout.write('└──────────────────────────────────────────────────────────────────────────┘\n\n');
    logger.info('dev seed accounts created', { count: seeded.length, emails: seeded.map((s) => s.email) });
  }

  return seeded;
}
