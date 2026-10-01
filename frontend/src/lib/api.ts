import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, readCookie } from './utils';
import type { ApiErrorBody, StreamHandlers } from './types';

/**
 * HTTP client for docs/API.md.
 *
 * Token handling:
 * - the access token lives in module memory only. It is never written to
 *   localStorage or a cookie, so a script-injection bug cannot exfiltrate a
 *   long-lived credential (§8).
 * - the refresh token is HttpOnly and server-set; the client cannot read it.
 * - a 401 triggers exactly one refresh-and-retry. Concurrent 401s share a single
 *   in-flight refresh so a burst of requests cannot rotate the family into a
 *   reuse-detection lockout.
 */

const BASE_PATH = '/api/v1';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Array<{ field: string; issue: string }>;
  readonly traceRef: string;

  constructor(status: number, body: ApiErrorBody['error'] | null, fallbackMessage: string) {
    super(body?.message ?? fallbackMessage);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.code ?? 'UNKNOWN';
    this.details = body?.details ?? [];
    this.traceRef = body?.traceRef ?? '';
  }

  /** Field-level messages for form binding (react-hook-form). */
  fieldIssue(field: string): string | undefined {
    return this.details.find((d) => d.field === field)?.issue;
  }
}

let accessToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}
export function getAccessToken(): string | null {
  return accessToken;
}
export function hasAccessToken(): boolean {
  return accessToken !== null;
}

type Listener = () => void;
const listeners = new Set<Listener>();

/** Notifies the auth context when the session changes (login, refresh, logout). */
export function onSessionChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  for (const listener of listeners) listener();
}

export interface ApiRequestInit extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Endpoints that rely on the cookie-borne refresh token need the CSRF header. */
  csrf?: boolean;
  query?: Record<string, string | number | boolean | undefined>;
}

function buildUrl(path: string, query?: ApiRequestInit['query']): string {
  const url = path.startsWith('http') ? path : `${BASE_PATH}${path}`;
  if (!query) return url;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${url}?${qs}` : url;
}

async function parseError(res: Response, fallback: string): Promise<ApiError> {
  let body: ApiErrorBody['error'] | null = null;
  try {
    const text = await res.text();
    if (text) {
      const parsed = JSON.parse(text) as ApiErrorBody;
      body = parsed.error ?? null;
    }
  } catch {
    body = null;
  }
  return new ApiError(res.status, body, fallback);
}

/** Single-flight refresh so parallel 401s cannot trip reuse detection. */
export async function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const csrf = readCookie(CSRF_COOKIE_NAME);
      const res = await fetch(`${BASE_PATH}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          ...(csrf ? { [CSRF_HEADER_NAME]: csrf } : {}),
        },
      });
      if (!res.ok) {
        accessToken = null;
        emit();
        return false;
      }
      const data = (await res.json()) as { accessToken: string };
      accessToken = data.accessToken;
      emit();
      return true;
    } catch {
      accessToken = null;
      emit();
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export function clearSession(): void {
  accessToken = null;
  emit();
}

/**
 * Test hook. `refreshInFlight` is a module-level single-flight guard, so a refresh
 * that never settles would be reused by every later caller in the same module
 * graph. Tests reset it explicitly; application code should use `clearSession`.
 */
export function resetAuthState(): void {
  accessToken = null;
  refreshInFlight = null;
}

/**
 * On bootstrap we do not have an access token, but the HttpOnly refresh cookie may
 * still be valid. Try to exchange it silently so a page reload keeps you signed in.
 */
export async function bootstrapSession(): Promise<boolean> {
  return refreshSession();
}

async function rawFetch(path: string, init: ApiRequestInit, attempt: number): Promise<Response> {
  // Destructure `body`/`csrf`/`query` out so only real RequestInit fields are forwarded.
  const { body, csrf, query, headers: incomingHeaders, ...rest } = init;

  const headers = new Headers(incomingHeaders);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  if (body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (csrf) {
    const token = readCookie(CSRF_COOKIE_NAME);
    if (token) headers.set(CSRF_HEADER_NAME, token);
  }

  const res = await fetch(buildUrl(path, query), {
    ...rest,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // One automatic refresh-and-retry on an expired access token.
  if (res.status === 401 && attempt === 0 && accessToken !== null) {
    const refreshed = await refreshSession();
    if (refreshed) return rawFetch(path, init, attempt + 1);
  }
  return res;
}

export async function apiFetch<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await rawFetch(path, init, 0);
  } catch (err) {
    // A network failure is not the same as an API error and must be reported
    // differently so the UI can offer a retry (R8).
    throw new ApiError(
      0,
      {
        code: 'NETWORK_ERROR',
        message: 'Cannot reach the server. Check your connection and try again.',
        traceRef: '',
      },
      err instanceof Error ? err.message : 'Network error',
    );
  }

  if (!res.ok) throw await parseError(res, `Request to ${path} failed.`);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? (JSON.parse(text) as T) : undefined) as T;
}

/* ------------------------------------------------------------------ SSE flow */

/**
 * Streams an assistant answer.
 *
 * `EventSource` only supports GET and cannot send an Authorization header, so this
 * POSTs and parses the `text/event-stream` body manually. Frames are dispatched in
 * arrival order; `onError` is terminal and must be surfaced to the user (R8).
 */
export async function streamMessage(
  conversationId: string,
  content: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await rawFetch(`/conversations/${conversationId}/messages`, {
    method: 'POST',
    csrf: false,
    body: { content },
    headers: { Accept: 'text/event-stream' },
    signal,
  }, 0);

  if (!res.ok) throw await parseError(res, 'Could not start the answer stream.');
  if (!res.body) throw new ApiError(502, { code: 'PROVIDER_UNAVAILABLE', message: 'The server did not return a stream.', traceRef: '' }, 'No stream body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = 'message';

  const dispatch = (event: string, data: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // ignore a malformed frame rather than crashing the stream
    }
    switch (event) {
      case 'meta':
        handlers.onMeta?.(parsed as Parameters<NonNullable<StreamHandlers['onMeta']>>[0]);
        break;
      case 'delta':
        handlers.onDelta?.((parsed as { text?: string }).text ?? '');
        break;
      case 'sources':
        handlers.onSources?.(parsed as Parameters<NonNullable<StreamHandlers['onSources']>>[0]);
        break;
      case 'usage':
        handlers.onUsage?.(parsed as Parameters<NonNullable<StreamHandlers['onUsage']>>[0]);
        break;
      case 'done':
        handlers.onDone?.(parsed as Parameters<NonNullable<StreamHandlers['onDone']>>[0]);
        break;
      case 'error':
        handlers.onError?.(parsed as Parameters<NonNullable<StreamHandlers['onError']>>[0]);
        break;
      default:
        break;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Frames are separated by a blank line; process only complete ones.
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) currentEvent = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
        else if (line.startsWith('data:')) dataLines.push(line.slice(5));
      }
      if (dataLines.length > 0) dispatch(currentEvent, dataLines.join('\n'));
      currentEvent = 'message';
      boundary = buffer.indexOf('\n\n');
    }
  }
}
