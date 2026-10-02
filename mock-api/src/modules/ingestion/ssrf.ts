import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { unsafeUrl } from '../../lib/errors';

/**
 * SSRF-safe outbound fetch for URL ingestion (§5 "source (upload | URL | ...)").
 *
 * This is the one place the server is told "go fetch an address" by an
 * authenticated human, which is the classic server-side-request entry point: the
 * app has network access to things the operator should not be able to read
 * through it (cloud metadata at 169.254.169.254, Postgres on 127.0.0.1, Redis,
 * the Docker socket's HTTP neighbours, internal admin panels). The controls:
 *
 * 1. `http:`/`https:` only, and no credentials in the URL.
 * 2. The hostname is resolved *before* the request, and **every** answer must be
 *    publicly routable; then the connection is made to that IP with `Host` and
 *    TLS SNI still carrying the original name. Resolving-then-connecting to the
 *    resolved address closes the DNS-rebinding window that a
 *    "validate-then-fetch-by-name" check leaves open.
 * 3. Redirects are followed by this module, one hop at a time, and each hop is
 *    re-validated. A public URL that 302s to `169.254.169.254` is a standard
 *    bypass of check 2 if the HTTP client follows it for you.
 * 4. Body size is capped *while streaming* (`INGEST_MAX_BYTES`), not from a
 *    `Content-Length` header that the sender controls.
 * 5. Content type must be one we can ingest.
 *
 * Loopback/private targets are refused by default. `INGEST_ALLOW_PRIVATE_NETWORKS`
 * exists so the pipeline can be tested end-to-end against a local fixture — this
 * sandbox has no route to the public internet (docs/ENVIRONMENT.md) — and
 * `config.ts` makes it a fatal boot error in production.
 */

/** Ports that should never be the destination of a "fetch this document" request. */
/**
 * Ports an ingestion fetch may connect to. This is an **allowlist**, not a denylist:
 * a list of "bad" ports (25, 445, 5432, 6379, 2375, …) is a race against every service
 * that has ever been written, and the one service that matters is the one nobody
 * thought to add. Public documents are served on 80 and 443, so that is the policy.
 *
 * `INGEST_ALLOW_PRIVATE_NETWORKS` relaxes it to "any port", because that flag already
 * means "this deployment fetches from internal infrastructure", which is routinely on
 * a non-standard port. It is off by default and refused in production by config.ts.
 */
const ALLOWED_PORTS = new Set([80, 443]);

const PUBLIC_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
  'application/pdf',
]);

export interface FetchedDocument {
  /** Final URL after redirects — stored as provenance (R2). */
  finalUrl: string;
  contentType: string;
  body: Buffer;
  sha256: string;
  bytes: number;
  pinnedIp: string;
  status: number;
}

export class FetchError extends Error {
  constructor(
    readonly kind: 'blocked-address' | 'too-large' | 'unsupported-type' | 'not-found' | 'timeout' | 'network' | 'policy',
    message: string,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

/* ------------------------------------------------------------ IP screening */

/**
 * True for every address that must not be reachable from an ingestion fetch.
 * Exported for direct unit testing: the *set* is the security property, and a
 * future refactor of the fetch path must not quietly narrow it.
 */
export function isBlockedAddress(input: string): boolean {
  const ip = input.trim().replace(/^\[|\]$/g, '');
  const family = net.isIP(ip);
  if (family === 0) return true; // not an IP ⇒ refuse, never guess
  if (family === 6) return isBlockedIpv6(ip);
  return isBlockedIpv4(ip);
}

/**
 * Refused even when `INGEST_ALLOW_PRIVATE_NETWORKS` is on.
 *
 * That flag exists so an operator can point ingestion at an internal wiki in RFC1918
 * space. It must never double as a switch that re-opens the link-local address where a
 * cloud instance metadata service answers (169.254.169.254 / fe80::), because fetching
 * there is how an "ingest this URL" button becomes stolen credentials. Link-local,
 * multicast, "this host" and the unspecified address are therefore in a tier of their
 * own. (A Teredo or 6to4 address embedding a link-local peer is not caught at this
 * tier; those whole ranges are refused whenever the flag is off, and the residual risk
 * is recorded in docs/SECURITY.md.)
 */
export function isAlwaysBlockedAddress(input: string): boolean {
  const ip = input.trim().replace(/^\[|\]$/g, '');
  const family = net.isIP(ip);
  if (family === 0) return true;
  if (family === 4) {
    const parts = ip.split('.').map((p) => Number(p));
    const [a, b] = parts as [number, number, number, number];
    if (a === 169 && b === 254) return true; // link-local incl. every cloud metadata endpoint
    if (a === 0) return true; // 0.0.0.0/8 "this host"
    if (a >= 224) return true; // multicast and reserved
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::') return true;
  const mapped = /^::ffff:([0-9.]+)$/.exec(lower);
  if (mapped?.[1] && net.isIP(mapped[1]) === 4) return isAlwaysBlockedAddress(mapped[1]);
  const hex = ipv6ToHex(lower);
  if (!hex) return true;
  const first = Number.parseInt(hex.slice(0, 4), 16);
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8
  return false;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC6598 CGNAT
  if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return true; // IETF/TEREDO relay
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // RFC2544 benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true; // TEST-NET-3
  if (a === 192 && b === 88 && parts[2] === 99) return true; // 6to4 anycast relay
  if (a >= 224) return true; // multicast 224/4, reserved 240/4, broadcast
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  // IPv4-mapped written as a dotted quad (::ffff:127.0.0.1) — screen the embedded v4.
  const mapped = /^::ffff:([0-9.]+)$/.exec(lower);
  if (mapped?.[1] && net.isIP(mapped[1]) === 4) return isBlockedIpv4(mapped[1]);
  const hex = ipv6ToHex(lower);
  if (!hex) return true; // unparseable form (e.g. zone ids) — refuse
  // `::ffff:7f00:1` and `::7f00:1` are the same addresses as the dotted forms above,
  // spelled in hex. Without this branch an attacker writes the loopback address in the
  // one notation the string check missed, so the embedded v4 is recovered from the
  // groups themselves rather than from any particular spelling.
  const embedded = embeddedIpv4(hex);
  if (embedded) return isBlockedIpv4(embedded);

  const first = Number.parseInt(hex.slice(0, 4), 16);
  const second = Number.parseInt(hex.slice(4, 8), 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  // Teredo (2001:0000::/32) and 6to4 (2002::/16) each embed a peer address that is not
  // screened here, so both are refused outright: a tunnel is exactly the bypass to stop.
  // Only those two prefixes — the wider 2000::/19 neighbourhood contains ordinary
  // public space such as 2001:4860::/32, and blocking it took the guard from "safe" to
  // "cannot fetch most of the internet".
  if (first === 0x2001 && second === 0x0000) return true;
  if (first === 0x2002) return true;
  if (first === 0x2001 && second === 0x0db8) return true; // documentation range
  if (first === 0x2001 && (second & 0xfff0) === 0x0020) return true; // 2001:20::/28 ORCHIDv2 (not globally routable)
  if (lower.startsWith('64:ff9b:')) return true; // NAT64 well-known prefix
  return false;
}

/**
 * The IPv4 encoded in the low 32 bits of an IPv6 address, when the address is one of
 * the embedded forms (`::ffff:a.b.c.d`, `::a.b.c.d`, or their hex-group spellings).
 * Returns null for a plain unicast v6 address.
 */
function embeddedIpv4(hex: string): string | null {
  // 80 leading zero bits, then either ffff (v4-mapped) or nothing (v4-compatible).
  const zeros = '0'.repeat(20);
  const isV4Mapped = hex.startsWith(zeros + 'ffff');
  const isV4Compatible = hex.startsWith('0'.repeat(24));
  if (!isV4Mapped && !isV4Compatible) return null;
  // The last 32 bits of the 32-hex-digit form are the embedded IPv4 address: two groups.
  const hi = Number.parseInt(hex.slice(24, 28), 16);
  const lo = Number.parseInt(hex.slice(28, 32), 16);
  if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** Expands an IPv6 literal to 8 4-digit hex groups. Returns null if malformed. */
function ipv6ToHex(ip: string): string | null {
  const zone = ip.indexOf('%');
  const bare = zone === -1 ? ip : ip.slice(0, zone);
  const parts = bare.split('::');
  if (parts.length > 2) return null;
  const toGroups = (segment: string): string[] | null => {
    if (segment === '') return [];
    const groups = segment.split(':');
    if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) {
      // A trailing dotted-quad inside an IPv6 literal (::ffff:127.0.0.1).
      const last = groups.at(-1) ?? '';
      if (groups.length > 0 && net.isIP(last) === 4) {
        const octets = last.split('.').map((o) => Number(o));
        const head = groups.slice(0, -1);
        const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
        const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
        return [...head, hi, lo];
      }
      return null;
    }
    return groups;
  };
  const head = toGroups(parts[0] ?? '');
  const tail = toGroups(parts[1] ?? '');
  if (!head || !tail) return null;
  const groups =
    parts.length === 2
      ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail]
      : [...head, ...tail];
  if (groups.length !== 8) return null;
  return groups.map((g) => g.padStart(4, '0')).join('');
}

/* -------------------------------------------------------------- URL policy */

export interface ParsedTarget {
  url: URL;
  hostname: string;
  port: number;
}

/** Scheme, credentials and port policy. Applied to every redirect hop too. */
export function checkUrlPolicy(raw: string): ParsedTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw unsafeUrl('That is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw unsafeUrl('Only http and https addresses can be fetched.');
  }
  if (url.username || url.password) {
    throw unsafeUrl('Credentials in the URL are not allowed.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname.length === 0) throw unsafeUrl('Missing host.');
  // A literal IPv6 in the URL is bracketed; `url.port` is empty for default ports.
  const port = url.port.length > 0 ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!ALLOWED_PORTS.has(port) && !config().INGEST_ALLOW_PRIVATE_NETWORKS) {
    throw unsafeUrl('Ingestion fetches only ports 80 and 443 (set INGEST_ALLOW_PRIVATE_NETWORKS for internal infrastructure).');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw unsafeUrl('Invalid port.');
  // No trailing dot: `example.com.` resolves but is not the host we screened.
  if (hostname.endsWith('.')) throw unsafeUrl('Invalid host.');
  return { url, hostname, port };
}

/** Resolves and screens every answer. Any private record fails the whole lookup. */
export async function resolveAndScreen(hostname: string): Promise<string> {
  const c = config();
  // Already an IP literal? Screen it directly — a DNS lookup on an IP is a no-op
  // that could be tricked by a hosts-file entry into something else.
  if (net.isIP(hostname)) {
    if (isAlwaysBlockedAddress(hostname)) {
      throw new FetchError('blocked-address', 'That address cannot be fetched from this server.');
    }
    if (c.INGEST_ALLOW_PRIVATE_NETWORKS) return hostname;
    // Same error class as the DNS branch: the pipeline keys its behaviour off
    // `FetchError.kind`, so a policy refusal has to carry that kind too. The message
    // names no address, because it can reach an operator-visible job error.
    if (isBlockedAddress(hostname)) throw new FetchError('blocked-address', 'That address cannot be fetched from this server.');
    return hostname;
  }
  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new FetchError('network', 'That host name could not be resolved.');
  }
  if (records.length === 0) throw new FetchError('network', 'That host name has no address records.');
  for (const r of records) {
    // Always-refused ranges are screened even with the private-network flag on.
    if (isAlwaysBlockedAddress(r.address)) {
      logger.warn('ingestion fetch refused: address is never fetchable', { hostname, family: r.family });
      throw new FetchError('blocked-address', 'That address resolves to a range that is never fetchable.');
    }
  }
  if (!c.INGEST_ALLOW_PRIVATE_NETWORKS) {
    for (const r of records) {
      if (isBlockedAddress(r.address)) {
        logger.warn('ingestion fetch refused: resolved to a non-public address', {
          hostname,
          family: r.family,
        });
        throw new FetchError('blocked-address', 'That address resolves outside the public internet.');
      }
    }
  }
  return records[0]!.address;
}

/* ------------------------------------------------------------ the fetcher */

interface Hop {
  target: ParsedTarget;
  ip: string;
}

export async function safeFetch(rawUrl: string, opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<FetchedDocument> {
  const c = config();
  const maxBytes = opts.maxBytes ?? c.INGEST_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? c.INGEST_TIMEOUT_MS;

  let hop: Hop | null = null;
  const seen = new Set<string>();

  for (let redirect = 0; redirect <= c.INGEST_MAX_REDIRECTS; redirect += 1) {
    const target = redirect === 0 ? checkUrlPolicy(rawUrl) : hop!.target;
    const ip = await resolveAndScreen(target.hostname);
    hop = { target, ip };

    const dedupeKey = `${target.url.href}`;
    if (seen.has(dedupeKey)) throw new FetchError('policy', 'That URL redirects to itself.');
    seen.add(dedupeKey);

    const result = await requestOne(target, ip, maxBytes, timeoutMs);

    if (result.status >= 300 && result.status < 400) {
      const location = result.headers.location;
      if (!location) throw new FetchError('policy', 'The server returned a redirect without a target.');
      if (redirect === c.INGEST_MAX_REDIRECTS) throw new FetchError('policy', 'Too many redirects.');
      let next: URL;
      try {
        next = new URL(location, target.url);
      } catch {
        throw unsafeUrl('The redirect target is not a valid URL.');
      }
      // Policy + screening for the next hop happen at the top of this loop, which is
      // the only ordering that cannot be bypassed by a self-redirect.
      hop = { target: checkUrlPolicy(next.href), ip: '' };
      continue;
    }

    if (result.status === 404 || result.status === 410) {
      throw new FetchError('not-found', `The source returned ${result.status}.`);
    }
    if (result.status >= 400) {
      throw new FetchError('network', `The source returned ${result.status}.`);
    }

    const contentType = (result.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (!PUBLIC_CONTENT_TYPES.has(contentType)) {
      throw new FetchError(
        'unsupported-type',
        `That source is ${contentType || 'an unknown type'}; ingestion accepts HTML, plain text, Markdown and PDF.`,
      );
    }

    return {
      finalUrl: target.url.href,
      contentType,
      body: result.body,
      sha256: createHash('sha256').update(result.body).digest('hex'),
      bytes: result.body.length,
      pinnedIp: ip,
      status: result.status,
    };
  }
  throw new FetchError('policy', 'Too many redirects.');
}

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * One HTTP(S) request, connected to the pinned IP while `Host`/SNI keep the real
 * name. `rejectUnauthorized` stays on, so pinning does not weaken TLS.
 */
function requestOne(target: ParsedTarget, ip: string, maxBytes: number, timeoutMs: number): Promise<RawResponse> {
  const c = config();
  const isHttps = target.url.protocol === 'https:';
  const lib = isHttps ? https : http;

  return new Promise<RawResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const options: SsrfRequestOptions = {
      // The socket connects to the screened address; the request carries the name.
      host: ip.includes(':') ? `[${ip}]` : ip,
      port: target.port,
      path: `${target.url.pathname}${target.url.search}`,
      method: 'GET',
      // A dedicated agent per request: reusing a pooled socket to a *name* would
      // undo the IP pinning this whole module exists for.
      agent: false,
      headersTimeout: Math.min(timeoutMs, 10_000),
      bodyTimeout: timeoutMs,
      timeout: timeoutMs,
      // `servername` is what certificate verification runs against, so pinning the
      // socket to an IP does not weaken TLS: a certificate for 169.254.169.254
      // will not validate for `standards.example.gov.in`.
      ...(isHttps ? { servername: target.hostname } : {}),
      headers: {
        host: target.port === 80 || target.port === 443 ? target.hostname : `${target.hostname}:${target.port}`,
        'user-agent': c.INGEST_USER_AGENT,
        accept: 'text/html,application/xhtml+xml,text/plain,text/markdown,application/pdf;q=0.9,*/*;q=0.1',
        'accept-language': 'en,hi;q=0.8',
        // No conditional request: a cached 304 would be read as "unchanged" by the
        // freshness monitor without anything being fetched.
        'cache-control': 'no-cache',
      },
    };

    const req = lib.request(options, (res) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
      }
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        // No body to read on a redirect; destroying the socket keeps the agent clean.
        res.destroy();
        finish(() => resolve({ status, headers, body: Buffer.alloc(0) }));
        return;
      }
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBytes) {
          res.destroy();
          finish(() =>
            reject(
              new FetchError('too-large', `The source is larger than the ${Math.round(maxBytes / 1_000_000)} MB ingestion limit.`),
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(() => resolve({ status, headers, body: Buffer.concat(chunks) })));
      res.on('error', (err: Error) => finish(() => reject(new FetchError('network', err.message))));
    });

    req.on('timeout', () => {
      req.destroy();
      finish(() => reject(new FetchError('timeout', 'The source did not respond in time.')));
    });
    req.on('error', (err: NodeJS.ErrnoException) => finish(() => reject(new FetchError('network', err.message))));
    req.end();
  });
}

/**
 * Node's `RequestOptions` for http and https differ on `servername`; this is the
 * union of the fields this module actually sets, so the shared literal type-checks
 * against both clients instead of being cast into silence.
 */
interface SsrfRequestOptions extends https.RequestOptions {
  agent?: boolean;
  headersTimeout?: number;
  bodyTimeout?: number;
  servername?: string;
}
