import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { loadConfig, resetConfig, setConfigForTests } from '../src/config';
import {
  FetchError,
  checkUrlPolicy,
  isAlwaysBlockedAddress,
  isBlockedAddress,
  resolveAndScreen,
  safeFetch,
} from '../src/modules/ingestion/ssrf';

/**
 * P2 §5/§8 — the server-side request forgery guard on the ingestion fetcher.
 *
 * An "ingest this URL" button reachable by a content manager is a request made *from*
 * the production network, so the guard has to hold without any cooperation from the
 * submitter. The unit half below pins the address set; the fetch half runs against a
 * real local HTTP server (the only network this sandbox has) and covers the pieces
 * that are easy to get wrong: per-hop re-screening, redirects, the size cap, the
 * content-type allowlist, and connecting to the screened IP rather than the name.
 */

const BODY = 'IS 10500:2012 Stainless Steel Sheet and Plate\n4.2 Chemical Composition\n';

let server: http.Server | null = null;
let origin = '';
let port = 0;
const redirectTargets = new Map<string, string>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? '/';
    if (path === '/ok.txt' || path === '/ok.md') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(BODY);
      return;
    }
    if (path === '/headers') {
      // text/plain, because the fetcher's own content-type allowlist would otherwise
      // refuse this response before the test could read what the server received.
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(JSON.stringify(req.headers));
      return;
    }
    if (path === '/image') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    if (path === '/no-type') {
      res.writeHead(200, {});
      res.end('body without a content type');
      return;
    }
    if (path === '/notfound') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('missing');
      return;
    }
    if (path === '/server-error') {
      res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '30' });
      res.end('down');
      return;
    }
    if (path === '/big') {
      // 400 KB of text, sent in chunks, to exercise the cap without filling the disk.
      res.writeHead(200, { 'content-type': 'text/plain' });
      const chunk = Buffer.from('x'.repeat(4096) + '\n');
      for (let i = 0; i < 100; i += 1) res.write(chunk);
      res.end();
      return;
    }
    if (path === '/unterminated') {
      // Declares more than it ever sends: a size cap that only counts complete
      // responses would let a hostile server hold the request open forever.
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(50 * 1024 * 1024) });
      res.write('small');
      return;
    }
    if (path === '/slow') {
      // Aborted clients are the normal outcome of a timeout, so the reply is guarded:
      // writing to a closed socket would surface as an unrelated server crash.
      const timer = setTimeout(() => {
        if (res.destroyed || res.writableEnded || res.headersSent) return;
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(BODY);
      }, 3_000);
      req.on('close', () => clearTimeout(timer));
      return;
    }
    if (path.startsWith('/redirect-to/')) {
      const key = path.slice('/redirect-to/'.length);
      res.writeHead(302, { location: redirectTargets.get(key) ?? '/' });
      res.end();
      return;
    }
    if (path === '/redirect-self') {
      res.writeHead(302, { location: `${origin}/redirect-self` });
      res.end();
      return;
    }
    if (path === '/chain-a') {
      res.writeHead(302, { location: `${origin}/chain-b` });
      res.end();
      return;
    }
    if (path === '/chain-b') {
      res.writeHead(302, { location: '/ok.txt' });
      res.end();
      // Every branch has to end here. Without this `return`, the fall-through below
      // writes a second response on a socket that already answered — which showed up
      // not as a failed assertion but as an unhandled ERR_HTTP_HEADERS_SENT that the
      // test runner blamed on whichever test happened to be running.
      return;
    }
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no such path');
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  port = (server!.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  redirectTargets.set('ok', `${origin}/ok.txt`);
  redirectTargets.set('metadata', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/');
  redirectTargets.set('loopback', `${origin}/ok.txt`);
});

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

function withConfig(overrides: Record<string, string>): void {
  setConfigForTests(
    loadConfig({ ...process.env, INGEST_ALLOW_PRIVATE_NETWORKS: 'true', ...overrides } as NodeJS.ProcessEnv),
  );
}

afterEach(() => {
  resetConfig();
  setConfigForTests(undefined);
});

describe('the blocked address set', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.10',
    '224.0.0.1',
    '239.10.0.1',
    '255.255.255.255',
  ])('refuses %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['::', '::1', 'fe80::1', 'ff02::1', 'fc00::1', 'fd12:3456::7', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '2001:db8::1', '64:ff9b::169.254.169.254'])(
    'refuses %s',
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(true);
    },
  );

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '151.101.0.35', '2001:4860:4860::8888', '2606:4700:4700::1111'])(
    'allows the public address %s',
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );

  it('refuses anything that is not an IP rather than guessing', () => {
    // `isBlockedAddress` is called with DNS answers and URL hosts both; an
    // unparseable host must never default to "allowed".
    expect(isBlockedAddress('localhost')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
    expect(isBlockedAddress('10.0.0.256')).toBe(true);
    expect(isBlockedAddress('fe80::1%eth0')).toBe(true);
  });

  it('normalises brackets, whitespace and case instead of being fooled by them', () => {
    expect(isBlockedAddress('[::1]')).toBe(true);
    expect(isBlockedAddress('  ::1  ')).toBe(true);
    expect(isBlockedAddress('::FFFF:7F00:1')).toBe(true);
  });

  it('refuses the metadata and link-local ranges even when private networks are allowed', () => {
    // This is the tier that makes `INGEST_ALLOW_PRIVATE_NETWORKS` safe to have at all:
    // the flag is for an internal wiki, not for the instance credential endpoint.
    for (const ip of ['169.254.169.254', '169.254.1.1', 'fe80::1', 'ff02::2', '0.0.0.0', '239.0.0.1', '::', '::ffff:169.254.169.254']) {
      expect(isAlwaysBlockedAddress(ip)).toBe(true);
    }
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.5']) {
      expect(isAlwaysBlockedAddress(ip)).toBe(false);
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });
});

describe('URL policy', () => {
  it('accepts an http(s) URL on a normal port', () => {
    const parsed = checkUrlPolicy('https://standards.example.gov.in/is/10500');
    expect(parsed.hostname).toBe('standards.example.gov.in');
    expect(parsed.port).toBe(443);
  });

  it('is an allowlist: any port other than 80 and 443 is refused', () => {
    for (const raw of ['http://example.com:8080/x', 'http://example.com:22/x', 'http://example.com:5432/', 'https://example.com:8443/y']) {
      expect(() => checkUrlPolicy(raw)).toThrow(/ports 80 and 443/);
    }
    // An internal deployment that opts into private ranges is also on odd ports, so
    // the same flag that widens the address set widens the port set — and only there.
    withConfig({});
    expect(checkUrlPolicy('http://127.0.0.1:8080/x').port).toBe(8080);
    expect(() => checkUrlPolicy('http://169.254.169.254:8080/')).not.toThrow();
  });

  it.each([
    ['file:///etc/passwd', /http and https/],
    ['gopher://example.com/x', /http and https/],
    ['ftp://example.com/x', /http and https/],
    ['data:text/plain,hello', /http and https/],
    ['javascript:alert(1)', /http and https/],
    ['http://user:***@example.com/x', /Credentials in the URL/],
    ['http://127.0.0.1:5432/', /ports 80 and 443/],
    ['http://example.com:6379/', /ports 80 and 443/],
    ['http://example.com.:80/', /Invalid host/],
    ['not a url', /valid URL/],
  ])('refuses %s', (raw, pattern) => {
    expect(() => checkUrlPolicy(raw)).toThrow(pattern);
  });

  it('does not let an obfuscated loopback spelling reach the socket', async () => {
    // Every one of these denotes 127.0.0.1. The WHATWG parser normalises most of them,
    // and whatever it leaves as-is is refused because it is not a parseable IP. Either
    // branch is safe; a *string* comparison against "127.0.0.1" would have been neither.
    for (const raw of ['http://127.1/', 'http://0x7f000001/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://[::ffff:7f00:1]/', 'http://[::1]/']) {
      const target = checkUrlPolicy(raw);
      await expect(resolveAndScreen(target.hostname)).rejects.toThrow(/cannot be fetched|outside the public internet|resolved to a range/);
    }
  });

  it('refuses a host that does not resolve instead of reporting an empty document', async () => {
    withConfig({ INGEST_ALLOW_PRIVATE_NETWORKS: 'false' });
    await expect(resolveAndScreen('no-such-host.invalid')).rejects.toThrow(/could not be resolved/);
  });

  it('names the metadata endpoint as blocked before any lookup happens', async () => {
    await expect(resolveAndScreen('169.254.169.254')).rejects.toThrow(/cannot be fetched/);
    await expect(resolveAndScreen('10.0.0.5')).rejects.toThrow(/cannot be fetched/);
  });

  it('screens the DNS answer, not just the literal, so a hosts-file name cannot slip through', async () => {
    withConfig({ INGEST_ALLOW_PRIVATE_NETWORKS: 'false' });
    // `localhost` is not an IP literal; only a lookup reveals it is loopback.
    await expect(resolveAndScreen('localhost')).rejects.toThrow(/outside the public internet|cannot be fetched/);
  });

  it('lets a loopback host through when the operator explicitly allowed private networks', async () => {
    withConfig({ INGEST_ALLOW_PRIVATE_NETWORKS: 'true' });
    await expect(resolveAndScreen('localhost')).resolves.toMatch(/127\.0\.0\.1|::1/);
  });

  it('fails on a host name that does not resolve, rather than reporting an empty document', async () => {
    withConfig({});
    await expect(resolveAndScreen('no-such-host.invalid')).rejects.toBeInstanceOf(FetchError);
  });
});

describe('safeFetch against a real server', () => {
  it('returns the body, its hash, the final URL and the pinned address', async () => {
    withConfig({});
    const doc = await safeFetch(`${origin}/ok.txt`);
    expect(doc.body.toString('utf8')).toBe(BODY);
    expect(doc.contentType).toBe('text/plain');
    expect(doc.bytes).toBe(Buffer.byteLength(BODY));
    expect(doc.sha256).toBe(crypto.createHash('sha256').update(BODY).digest('hex'));
    expect(doc.finalUrl).toBe(`${origin}/ok.txt`);
    expect(doc.pinnedIp).toBe('127.0.0.1');
    expect(doc.status).toBe(200);
  });

  it('sends the configured user agent and no credentials', async () => {
    withConfig({ INGEST_USER_AGENT: 'bis-saathi-test/1.0' });
    const doc = await safeFetch(`${origin}/headers`);
    const headers = JSON.parse(doc.body.toString('utf8')) as Record<string, string>;
    expect(headers['user-agent']).toBe('bis-saathi-test/1.0');
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    // The Host header keeps the real name even though the socket went to an IP.
    expect(headers.host).toBe(`127.0.0.1:${port}`);
  });

  it('refuses a content type that is not a document', async () => {
    withConfig({});
    await expect(safeFetch(`${origin}/image`)).rejects.toMatchObject({ kind: 'unsupported-type' });
    await expect(safeFetch(`${origin}/no-type`)).rejects.toMatchObject({ kind: 'unsupported-type' });
  });

  it('maps a 404 to a kind the freshness monitor reads as LINK_ROT', async () => {
    withConfig({});
    await expect(safeFetch(`${origin}/notfound`)).rejects.toMatchObject({ kind: 'not-found' });
    await expect(safeFetch(`${origin}/server-error`)).rejects.toMatchObject({ kind: 'network' });
  });

  it('caps the response at INGEST_MAX_BYTES while it is streaming, not after', async () => {
    withConfig({ INGEST_MAX_BYTES: String(64 * 1024) });
    const started = Date.now();
    await expect(safeFetch(`${origin}/big`)).rejects.toMatchObject({ kind: 'too-large' });
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it('aborts a server that announces more than it sends', async () => {
    withConfig({ INGEST_MAX_BYTES: String(8 * 1024 * 1024), INGEST_TIMEOUT_MS: '1200' });
    const err = await safeFetch(`${origin}/unterminated`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).kind).toMatch(/timeout|network|too-large/);
  });

  it('times out instead of waiting forever', async () => {
    // 1000ms is the floor the contract accepts; below that a slow official PDF would be
    // failed by the client rather than by the server.
    withConfig({ INGEST_TIMEOUT_MS: '1000' });
    await expect(safeFetch(`${origin}/slow`)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('follows a redirect and re-checks the policy on every hop', async () => {
    withConfig({ INGEST_MAX_REDIRECTS: '3' });
    const doc = await safeFetch(`${origin}/chain-a`);
    expect(doc.finalUrl).toBe(`${origin}/ok.txt`);
    expect(doc.body.toString('utf8')).toBe(BODY);
  });

  it('stops on a redirect loop', async () => {
    withConfig({ INGEST_MAX_REDIRECTS: '3' });
    await expect(safeFetch(`${origin}/redirect-self`)).rejects.toMatchObject({ kind: 'policy' });
  });

  it('refuses a redirect into the link-local metadata range even with private networks allowed', async () => {
    // The whole point of screening per hop: the submitter only supplied an ordinary
    // loopback URL, and the *server* decided where the second hop went.
    withConfig({ INGEST_ALLOW_PRIVATE_NETWORKS: 'true' });
    await expect(safeFetch(`${origin}/redirect-to/metadata`)).rejects.toMatchObject({ kind: 'blocked-address' });
  });

  it('refuses an address outside the policy before connecting', async () => {
    withConfig({ INGEST_ALLOW_PRIVATE_NETWORKS: 'false' });
    await expect(safeFetch('http://127.0.0.1/x')).rejects.toMatchObject({ kind: 'blocked-address' });
    // Refused for policy reasons even with private networks allowed, because the
    // metadata address is never fetchable.
    withConfig({ INGEST_ALLOW_PRIVATE_NETWORKS: 'true' });
    await expect(safeFetch('http://169.254.169.254/latest/meta-data/')).rejects.toMatchObject({ kind: 'blocked-address' });
  });

  it('never puts the internal address in the error a caller might display', async () => {
    withConfig({ INGEST_ALLOW_PRIVATE_NETWORKS: 'false' });
    const err = (await safeFetch('http://10.1.2.3/secret').catch((e: unknown) => e)) as FetchError;
    expect(err).toBeInstanceOf(FetchError);
    expect(err.message).not.toContain('10.1.2.3');
    expect(err.message).not.toContain(':80');
  });
});
