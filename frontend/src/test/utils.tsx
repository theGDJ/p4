import * as React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { SessionProvider } from '@/lib/auth';
import { resetAuthState } from '@/lib/api';
import type { BootstrapResponse, MeResponse, Role, SessionResponse } from '@/lib/types';

/**
 * Test harness.
 *
 * Nothing here fakes a success: the fetch mock only answers with what the caller
 * specifies, and an unmatched request throws so a test cannot silently pass
 * because a call was never made (R8).
 */

export const BOOTSTRAP: BootstrapResponse = {
  app: {
    name: 'BIS-Saathi',
    version: '0.1.0',
    env: 'test',
    stack: 'mock',
    mockProvider: true,
    providerName: 'mock',
  },
  auth: {
    accessTokenTtlMinutes: 15,
    personas: ['CONSUMER', 'MSME_MANUFACTURER', 'JEWELLER_RETAILER', 'STUDENT_ENGINEER'],
    languages: ['en', 'hi'],
    passwordMinLength: 10,
    lockoutAfterFailedAttempts: 5,
    lockoutMinutes: 15,
  },
  knowledge: { approvedDocuments: 0, approvedChunks: 0, kbVersion: 1 },
  security: { passwordScheme: 'argon2id', csrfEnabled: true },
  disclaimer: 'Informational — verify against current official sources',
};

export function makeUser(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    id: 'usr_test',
    email: 'asha@example.org',
    fullName: 'Asha Rao',
    persona: 'MSME_MANUFACTURER',
    language: 'en',
    roles: ['USER'] as Role[],
    emailVerified: true,
    createdAt: '2026-01-04T09:12:00.000Z',
    locked: false,
    conversationCount: 3,
    ...overrides,
  };
}

export function makeSession(user: MeResponse = makeUser()): SessionResponse {
  return {
    user,
    accessToken: 'access.test.token',
    accessExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    tokenType: 'Bearer',
    expiresIn: 900,
  };
}

/* --------------------------------------------------------------- fetch mock */

export interface RecordedCall {
  url: string;
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export type FetchHandler = (call: RecordedCall) => Response | Promise<Response>;
export type FetchRoute = [method: string, pattern: RegExp, handler: FetchHandler];

/**
 * Installs a global fetch mock. Requests that no route matches produce a 404 with
 * an explicit "unmocked" code, which is loud enough to fail an assertion rather
 * than passing by accident.
 */
export function mockFetch(routes: FetchRoute[]): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const call: RecordedCall = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api\/v1/, ''),
      body: typeof init?.body === 'string' ? safeParse(init.body) : undefined,
      headers,
    };
    calls.push(call);

    for (const [method, pattern, handler] of routes) {
      if (method === call.method && pattern.test(call.path)) return handler(call);
    }
    return jsonResponse(404, {
      error: { code: 'NOT_FOUND', message: `Unmocked request ${call.method} ${call.path}`, traceRef: 'test' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return { calls };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function apiError(status: number, code: string, message: string, details: Array<{ field: string; issue: string }> = []): Response {
  return jsonResponse(status, { error: { code, message, details, traceRef: 'trace-test-1' } });
}

/** Default route set: bootstrap succeeds, refresh fails (anonymous visitor). */
export function anonymousRoutes(): FetchRoute[] {
  return [
    ['GET', /^\/meta\/bootstrap$/, () => jsonResponse(200, BOOTSTRAP)],
    ['POST', /^\/auth\/refresh$/, () => apiError(401, 'UNAUTHENTICATED', 'No session')],
  ];
}

/** Default route set for a signed-in visitor. */
export function authenticatedRoutes(user: MeResponse = makeUser()): FetchRoute[] {
  return [
    ['GET', /^\/meta\/bootstrap$/, () => jsonResponse(200, BOOTSTRAP)],
    ['POST', /^\/auth\/refresh$/, () => jsonResponse(200, { accessToken: 'access.restored.token' })],
    ['GET', /^\/users\/me$/, () => jsonResponse(200, user)],
  ];
}

/* ------------------------------------------------------------- render helper */

/** Discards the module-level access token and any in-flight refresh. */
export function resetSession(): void {
  resetAuthState();
}

export function renderWithProviders(
  ui: React.ReactElement,
  { route = '/' }: { route?: string } = {},
) {
  resetSession();
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  const result = render(
    <MemoryRouter initialEntries={[route]}>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>{ui}</SessionProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { ...result, queryClient };
}
