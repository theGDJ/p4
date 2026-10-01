import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider } from '@/lib/auth';
import { App } from '@/App';
import {
  anonymousRoutes,
  apiError,
  authenticatedRoutes,
  jsonResponse,
  makeUser,
  mockFetch,
  resetSession,
  type FetchRoute,
} from './utils';

/**
 * Protected routes and role gates.
 *
 * §4 is explicit that these guards are COSMETIC. Every assertion here is about what
 * the UI *renders*; the real control lives in mock-api/tests/authz-idor.test.ts,
 * which proves the same routes return 401/403/404 to a caller who ignores the UI.
 */

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderApp(route: string, routes: FetchRoute[]) {
  resetSession();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const { calls } = mockFetch(routes);
  const user = userEvent.setup();
  const result = render(
    <MemoryRouter initialEntries={[route]}>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <LocationProbe />
          <App />
        </SessionProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  const location = () => screen.getByTestId('location').textContent ?? '';
  return { ...result, user, location, queryClient, calls };
}

const chatRoutes: FetchRoute[] = [
  ['GET', /^\/conversations$/, () => jsonResponse(200, { items: [], total: 0 })],
  ['GET', /^\/admin\/knowledge\/stats$/, () => jsonResponse(200, { documents: 0, chunks: 0, kbVersion: 1, jobs: 0, coverage: { derivedFrom: 'ingestion state', documentsApproved: 0, note: 'n/a' } })],
  ['GET', /^\/admin\/ingestion\/jobs$/, () => jsonResponse(200, { items: [], total: 0, failed: 0 })],
  ['GET', /^\/admin\/audit-logs$/, () => jsonResponse(200, { items: [] })],
];

describe('Anonymous visitors', () => {
  it('redirects /chat to /login and preserves the intended destination', async () => {
    const { location } = renderApp('/chat', [...chatRoutes, ...anonymousRoutes()]);

    expect(await screen.findByRole('heading', { level: 1, name: /Sign in to BIS-Saathi/i })).toBeInTheDocument();
    expect(location()).toBe('/login?next=%2Fchat');
  });

  it('redirects /dashboard to /login', async () => {
    const { location } = renderApp('/dashboard', [...chatRoutes, ...anonymousRoutes()]);

    await screen.findByRole('heading', { level: 1, name: /Sign in to BIS-Saathi/i });
    expect(location()).toBe('/login?next=%2Fdashboard');
  });

  it('redirects /admin to /login rather than showing a forbidden panel', async () => {
    const { location } = renderApp('/admin', [...chatRoutes, ...anonymousRoutes()]);

    await screen.findByRole('heading', { level: 1, name: /Sign in to BIS-Saathi/i });
    expect(location()).toBe('/login?next=%2Fadmin');
  });

  it('sends an already-signed-in visitor away from /login', async () => {
    const { location } = renderApp('/login?next=%2Fchat', [...chatRoutes, ...authenticatedRoutes()]);

    await waitFor(() => expect(location()).toBe('/chat'));
    expect(screen.queryByRole('heading', { level: 1, name: /Sign in to BIS-Saathi/i })).not.toBeInTheDocument();
  });

  it('shows a 404 page for an unknown route', async () => {
    const { location } = renderApp('/no-such-page', [...chatRoutes, ...anonymousRoutes()]);

    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    expect(location()).toBe('/no-such-page');
    // The attempted path is echoed back for diagnosis (rendered as text, never HTML).
    expect(screen.getByText('/no-such-page', { selector: 'p.std-no.break-all' })).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });
});

describe('Session restoration', () => {
  it('does not bounce a signed-in user to /login while the refresh is still in flight', async () => {
    let release!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });

    const { location } = renderApp('/chat', [
      ['POST', /^\/auth\/refresh$/, () => gate],
      ['GET', /^\/meta\/bootstrap$/, () => jsonResponse(200, { app: { mockProvider: false }, auth: {}, knowledge: {}, security: {}, disclaimer: '' })],
      ['GET', /^\/users\/me$/, () => jsonResponse(200, makeUser())],
      ...chatRoutes,
    ]);

    // Still on /chat, showing a busy state — NOT redirected.
    try {
      expect(await screen.findByRole('status')).toBeInTheDocument();
      expect(screen.getByText('Loading…')).toBeInTheDocument();
      expect(location()).toBe('/chat');
      expect(screen.queryByRole('heading', { level: 1, name: /Sign in to BIS-Saathi/i })).not.toBeInTheDocument();
    } finally {
      // Always settle the gate: a pending refresh would poison later tests.
      release(jsonResponse(200, { accessToken: 'access.restored.token' }));
    }

    expect(await screen.findByLabelText('Your question')).toBeInTheDocument();
    expect(location()).toBe('/chat');
  });

  it('falls back to anonymous when /users/me rejects the restored token with 401', async () => {
    const { location } = renderApp('/chat', [
      ['POST', /^\/auth\/refresh$/, () => jsonResponse(200, { accessToken: 'stale.token' })],
      ['GET', /^\/users\/me$/, () => apiError(401, 'UNAUTHENTICATED', 'No session')],
      ...chatRoutes,
      ...anonymousRoutes().filter(([method]) => method !== 'POST'),
    ]);

    expect(await screen.findByRole('heading', { level: 1, name: /Sign in to BIS-Saathi/i })).toBeInTheDocument();
    expect(location()).toBe('/login?next=%2Fchat');
  });
});

describe('Role gates', () => {
  it('denies a USER the admin page without calling any admin endpoint', async () => {
    const { calls } = renderApp('/admin', [
      ...chatRoutes,
      ...authenticatedRoutes(makeUser({ roles: ['USER'] })),
    ]);

    expect(await screen.findByText('You do not have access')).toBeInTheDocument();
    expect(screen.getByText(/This area requires a role your account does not have/i)).toBeInTheDocument();
    expect(calls.filter((c) => c.path.startsWith('/admin'))).toHaveLength(0);
  });

  it('admits CONTENT_MANAGER to the knowledge panel but not the audit log', async () => {
    renderApp('/admin', [...chatRoutes, ...authenticatedRoutes(makeUser({ roles: ['CONTENT_MANAGER'] }))]);

    expect(await screen.findByRole('heading', { level: 1, name: 'Administration' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Knowledge base' })).toBeInTheDocument();
    // ADMIN-only section renders the restriction instead of fetching.
    expect(screen.getAllByText('Audit logs are restricted to the ADMIN role.').length).toBeGreaterThan(0);
  });

  it('admits ADMIN to both panels (ADMIN ⊃ CONTENT_MANAGER)', async () => {
    const { calls } = renderApp('/admin', [...chatRoutes, ...authenticatedRoutes(makeUser({ roles: ['ADMIN'] }))]);

    expect(await screen.findByRole('heading', { level: 1, name: 'Administration' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Knowledge base' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Audit log' })).toBeInTheDocument();

    await waitFor(() => {
      const adminCalls = calls.filter((c) => c.path.startsWith('/admin')).map((c) => c.path);
      expect(adminCalls).toContain('/admin/knowledge/stats');
      expect(adminCalls).toContain('/admin/audit-logs');
    });
  });

  it('hides the admin nav link from a USER', async () => {
    renderApp('/', [...chatRoutes, ...authenticatedRoutes(makeUser({ roles: ['USER'] }))]);
    // Wait for /users/me, not just for the landing page: hasRole() reads the
    // profile, so asserting before it resolves would pass for the wrong reason.
    expect(await screen.findByRole('button', { name: /Asha Rao/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Administration' })).not.toBeInTheDocument();
    // The assistant link exists in both the masthead nav and the page CTA.
    expect(screen.getAllByRole('link', { name: 'Ask the assistant' }).length).toBeGreaterThan(0);
  });

  it('shows the admin nav link to a CONTENT_MANAGER', async () => {
    renderApp('/', [...chatRoutes, ...authenticatedRoutes(makeUser({ roles: ['CONTENT_MANAGER'], id: 'usr_cm' }))]);
    expect(await screen.findByRole('link', { name: 'Administration' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Asha Rao/i })).toBeInTheDocument();
  });

  it('surfaces a server-side 403 as an error state rather than an empty panel', async () => {
    // The UI gate is cosmetic: if a stale role lets the request through, the 403
    // must still be visible and retryable (R8).
    renderApp('/admin', [
      ...chatRoutes.filter(([, pattern]) => !pattern.source.includes('audit')),
      ['GET', /^\/admin\/audit-logs$/, () => apiError(403, 'FORBIDDEN', 'Insufficient role')],
      ...authenticatedRoutes(makeUser({ roles: ['ADMIN'] })),
    ]);

    expect(await screen.findByRole('heading', { level: 1, name: 'Administration' })).toBeInTheDocument();
    expect(await screen.findByText('Insufficient role')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Try again/i }).length).toBeGreaterThan(0);
  });
});

describe('Sign out', () => {
  it('clears the session and returns to the landing page', async () => {
    const { user, location } = renderApp('/dashboard', [
      ['POST', /^\/auth\/logout$/, () => new Response(null, { status: 204 })],
      ...chatRoutes,
      ...authenticatedRoutes(),
    ]);

    await screen.findByRole('heading', { level: 1, name: /Welcome, Asha Rao/i });
    await user.click(screen.getByRole('button', { name: /Asha Rao/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));

    await waitFor(() => expect(location()).toBe('/'));
    expect(await screen.findByRole('heading', { level: 1, name: /Ask about Indian Standards/i })).toBeInTheDocument();
  });

  it('sends the CSRF header on logout because the flow is cookie-borne', async () => {
    document.cookie = 'XSRF-TOKEN=csrf-test-value; path=/';
    const { user, calls } = renderApp('/dashboard', [
      ['POST', /^\/auth\/logout$/, () => new Response(null, { status: 204 })],
      ...chatRoutes,
      ...authenticatedRoutes(),
    ]);

    await screen.findByRole('heading', { level: 1, name: /Welcome, Asha Rao/i });
    await user.click(screen.getByRole('button', { name: /Asha Rao/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));

    await waitFor(() => expect(calls.some((c) => c.path === '/auth/logout')).toBe(true));
    const logout = calls.find((c) => c.path === '/auth/logout');
    expect(logout?.headers['x-xsrf-token']).toBe('csrf-test-value');
  });
});
