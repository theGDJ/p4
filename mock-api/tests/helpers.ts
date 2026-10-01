import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app';
import { createStore, type Store } from '../src/db/store';
import { loadConfig, resetConfig, setConfigForTests } from '../src/config';
import { resetProviders } from '../src/rag/providers';

/**
 * Test harness.
 *
 * Every call to `newApp()` builds a fresh store AND a fresh rate limiter, so
 * suites that intentionally exhaust a limit cannot poison their neighbours.
 */
export function newApp(): { app: Express; store: Store } {
  resetConfig();
  const store = createStore();
  return { app: createApp(store), store };
}

export const BASE = '/api/v1';

export interface Session {
  app: Express;
  store: Store;
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
}

function readCookies(res: { headers: Record<string, string | string[] | undefined> }): Record<string, string> {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: Record<string, string> = {};
  for (const line of list) {
    const [pair] = line.split(';');
    if (!pair) continue;
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return out;
}

export const TEST_PASSWORD = 'Correct-Horse-9';

let counter = 0;
export function uniqueEmail(prefix = 'user'): string {
  counter += 1;
  return `${prefix}${counter}.${Date.now().toString(36)}@example.test`;
}

/** Registers a user and returns a fully-populated session. */
export async function registerSession(
  app: Express,
  overrides: { fullName?: string; persona?: string; language?: string; roles?: string[] } = {},
): Promise<Session> {
  const email = uniqueEmail(overrides.fullName?.split(' ')[0]?.toLowerCase() ?? 'user');
  const res = await request(app)
    .post(`${BASE}/auth/register`)
    .send({
      email,
      password: TEST_PASSWORD,
      fullName: overrides.fullName ?? 'Test Person',
      ...(overrides.persona ? { persona: overrides.persona } : {}),
      ...(overrides.language ? { language: overrides.language } : {}),
    })
    .expect(201);

  const cookies = readCookies(res);
  // `store` is filled in by `newSession`; registering through the public API alone
  // cannot set roles, which is exactly the property the authz tests assert.
  return {
    app,
    store: undefined as unknown as Store,
    userId: res.body.user.id,
    email: res.body.user.email,
    accessToken: res.body.accessToken,
    refreshToken: cookies['bs_refresh'] ?? '',
    csrfToken: cookies['XSRF-TOKEN'] ?? '',
  };
}

/** Registers and returns both the session and the store it lives in. */
export async function newSession(
  overrides: { fullName?: string; persona?: string; language?: string; roles?: string[] } = {},
): Promise<Session> {
  const { app, store } = newApp();
  const session = await registerSession(app, overrides);
  session.store = store;
  if (overrides.roles) {
    const user = store.users.rows.get(session.userId);
    if (user) user.roles = overrides.roles as typeof user.roles;
  }
  return session;
}

/** Logs in an existing account on a given app. */
export async function loginSession(
  app: Express,
  email: string,
  password: string,
): Promise<{ accessToken: string; refreshToken: string; csrfToken: string; status: number; body: unknown }> {
  const res = await request(app).post(`${BASE}/auth/login`).send({ email, password });
  const cookies = readCookies(res);
  return {
    status: res.status,
    body: res.body,
    accessToken: (res.body as { accessToken?: string })?.accessToken ?? '',
    refreshToken: cookies['bs_refresh'] ?? '',
    csrfToken: cookies['XSRF-TOKEN'] ?? '',
  };
}

export { readCookies };

/** Sends a chat message and returns the parsed SSE frames. */
export async function askSse(
  app: Express,
  accessToken: string,
  conversationId: string,
  content: string,
  language?: 'en' | 'hi',
): Promise<{
  status: number;
  text: string;
  meta: Record<string, unknown> | null;
  deltas: string[];
  sources: Array<Record<string, unknown>>;
  evidenceTier: string | null;
  usage: Record<string, unknown> | null;
  done: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}> {
  const res = await request(app)
    .post(`${BASE}/conversations/${conversationId}/messages`)
    .set('Authorization', `Bearer ${accessToken}`)
    .set('Accept', 'text/event-stream')
    .send({ content, ...(language ? { language } : {}) });

  const frames: Array<{ event: string; data: unknown }> = [];
  let currentEvent = 'message';
  for (const line of String(res.text).split('\n')) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      try {
        frames.push({ event: currentEvent, data: JSON.parse(line.slice(6)) });
      } catch {
        frames.push({ event: currentEvent, data: line.slice(6) });
      }
    }
  }

  const find = (event: string) => frames.find((f) => f.event === event)?.data ?? null;
  const sourcesFrame = find('sources') as { sources?: unknown[]; evidenceTier?: string } | null;

  return {
    status: res.status,
    text: String(res.text),
    meta: find('meta') as Record<string, unknown> | null,
    deltas: frames.filter((f) => f.event === 'delta').map((f) => (f.data as { text?: string })?.text ?? ''),
    sources: (sourcesFrame?.sources ?? []) as Array<Record<string, unknown>>,
    evidenceTier: sourcesFrame?.evidenceTier ?? null,
    usage: find('usage') as Record<string, unknown> | null,
    done: find('done') as Record<string, unknown> | null,
    error: find('error') as Record<string, unknown> | null,
  };
}

export async function newConversation(app: Express, accessToken: string, title?: string): Promise<string> {
  const res = await request(app)
    .post(`${BASE}/conversations`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send(title ? { title } : {})
    .expect(201);
  return res.body.id as string;
}

/* ------------------------------------------------------------------------- *
 * P2 helpers: a local stand-in for an OpenAI-compatible provider.
 *
 * The vendor APIs are unreachable from this sandbox (docs/ENVIRONMENT.md), so
 * "the real provider works" can only be proven against a local server that speaks
 * the same wire format. That is what this is: the request shape our client sends
 * and the response shape it parses are both asserted for real, while the vendor's
 * own behaviour remains unverified here.
 * ------------------------------------------------------------------------- */

export interface FakeRequest {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

export interface FakeProvider {
  baseUrl: string;
  port: number;
  calls: FakeRequest[];
  /** Queue one entry per call; a number is an HTTP status, an object is a 200 JSON body. */
  replies: Array<{ status?: number; json?: unknown; headers?: Record<string, string>; delayMs?: number }>;
  close(): Promise<void>;
}

export async function startFakeProvider(
  replies: FakeProvider['replies'] = [],
): Promise<FakeProvider> {
  const calls: FakeRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      } catch {
        parsed = { _raw: Buffer.concat(chunks).toString('utf8') };
      }
      calls.push({
        path: req.url ?? '',
        method: req.method ?? '',
        headers: req.headers,
        body: parsed,
      });
      // An unqueued reply is a 500 naming the mistake, so a test that forgets to
      // queue one fails loudly instead of silently reading a canned 'ok'.
      const reply = replies.shift() ?? {
        status: 500,
        json: { error: { message: 'fake provider: no canned reply was queued for call ' + calls.length } },
      };
      const send = (): void => {
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
        res.end(JSON.stringify(reply.json ?? {}));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    calls,
    replies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Points the LLM and embedding providers at `baseUrl` and rebuilds the clients. */
export function useProviderConfig(overrides: Record<string, string | undefined>): void {
  const env = { ...process.env, ...overrides };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  setConfigForTests(loadConfig(env as NodeJS.ProcessEnv));
  resetProviders();
}
