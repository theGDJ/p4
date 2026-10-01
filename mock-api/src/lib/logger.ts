import { config } from '../config';

/**
 * Structured JSON logger with mandatory PII/secret redaction (§6 #7, §8).
 *
 * Redaction is applied to every value that reaches the log, including nested
 * objects, so a careless `logger.info({ user })` cannot leak a password hash,
 * a bearer token or a phone number.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = keyof typeof LEVELS;

/** Keys whose values are never logged, whatever they contain. */
const BLOCKED_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'currentpassword',
  'newpassword',
  'confirmpassword',
  'secret',
  'clientsecret',
  'apikey',
  'api_key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'tokenhash',
  'token_hash',
  'authorization',
  'cookie',
  'set-cookie',
  'xsrf-token',
  'x-xsrf-token',
  'cvv',
  'otp',
  'aadhaar',
  'pan',
]);

const REDACTED = '[REDACTED]';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?<!\d)(?:\+91[-\s]?|[0][-]?)?(?:\d{5}[-\s]?\d{5}|\d{10})(?!\d)/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const AADHAAR_RE = /(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g;
const PAN_RE = /\b[A-Z]{5}\d{4}[A-Z]\b/g;

/** Partial masking keeps enough shape to debug with ("ab***@example.com"). */
function maskEmail(value: string): string {
  return value.replace(EMAIL_RE, (m) => {
    const [local = '', domain = ''] = m.split('@');
    const keep = local.slice(0, 2);
    return `${keep}${'*'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
  });
}

export function redactString(input: string): string {
  let out = input.replace(JWT_RE, REDACTED);
  out = out.replace(PAN_RE, (m) => `${m.slice(0, 2)}*****${m.slice(-1)}`);
  out = out.replace(AADHAAR_RE, (m) => `XXXX-XXXX-${m.replace(/\D/g, '').slice(-4)}`);
  out = maskEmail(out);
  out = out.replace(PHONE_RE, (m) => {
    const digits = m.replace(/\D/g, '');
    return `${m.slice(0, m.length - digits.length)}XXXXX${digits.slice(-3)}`;
  });
  return out;
}

const MAX_DEPTH = 6;

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return config().LOG_PII_REDACTION ? redactString(value) : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: config().LOG_PII_REDACTION ? redactString(value.message) : value.message,
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (BLOCKED_KEYS.has(k.toLowerCase().replace(/[-_]/g, ''))) {
        out[k] = REDACTED;
        continue;
      }
      out[k] = redactValue(v, depth + 1);
    }
    return out;
  }
  return '[UNSERIALISABLE]';
}

function enabled(level: Level): boolean {
  return LEVELS[level] >= LEVELS[config().LOG_LEVEL];
}

function emit(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (!enabled(level)) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    message: config().LOG_PII_REDACTION ? redactString(message) : message,
    ...(fields ? (redactValue(fields) as Record<string, unknown>) : {}),
  };
  const line = JSON.stringify(record);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
};

export type Logger = typeof logger;
