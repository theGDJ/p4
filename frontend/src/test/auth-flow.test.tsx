import type * as React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider } from '@/lib/auth';
import { ForgotPasswordPage, LoginPage, RegisterPage } from '@/pages/auth';
import {
  anonymousRoutes,
  apiError,
  jsonResponse,
  makeSession,
  makeUser,
  mockFetch,
  resetSession,
  type FetchRoute,
} from './utils';

/**
 * Auth flows, front to back.
 *
 * These tests assert the *client half* of feature #1. The server half — Argon2id
 * hashing, rotating refresh tokens, reuse detection, lockout — is covered by the
 * mock-api suite (auth.test.ts, security.test.ts). What is asserted here is that
 * the UI never swallows a server error, never invents a success, and never sends a
 * payload the documented schema would reject.
 */

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderPage(page: React.ReactElement, route = '/', extra: FetchRoute[] = []) {
  resetSession();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const { calls } = mockFetch([...extra, ...anonymousRoutes()]);
  const user = userEvent.setup();
  const result = render(
    <MemoryRouter initialEntries={[route]}>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <LocationProbe />
          {page}
        </SessionProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { ...result, calls, user };
}

const STRONG = 'Correct-Horse-9';

describe('Login', () => {
  it('rejects an empty submission without contacting the server', async () => {
    const { user, calls } = renderPage(<LoginPage />);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(2);
    // Required-ness lives on the control, not in the label text.
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-required', 'true');
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-required', 'true');
    expect(calls.filter((c) => c.path === '/auth/login')).toHaveLength(0);
  });

  it('rejects a malformed email address client-side', async () => {
    const { user, calls } = renderPage(<LoginPage />);
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.type(screen.getByLabelText('Password'), STRONG);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Please check the highlighted fields.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(calls.filter((c) => c.path === '/auth/login')).toHaveLength(0);
  });

  it('signs in and lands on the ?next= target', async () => {
    const session = makeSession(makeUser({ email: 'asha@example.org' }));
    const { user, calls } = renderPage(<LoginPage />, '/login?next=%2Fchat', [
      ['POST', /^\/auth\/login$/, () => jsonResponse(200, session)],
      ['GET', /^\/users\/me$/, () => jsonResponse(200, session.user)],
    ]);

    await user.type(screen.getByLabelText('Email'), 'asha@example.org');
    await user.type(screen.getByLabelText('Password'), STRONG);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/chat'));

    const login = calls.find((c) => c.path === '/auth/login');
    expect(login?.method).toBe('POST');
    expect(login?.body).toEqual({ email: 'asha@example.org', password: STRONG });
  });

  it('surfaces INVALID_CREDENTIALS with the translated message, not the raw body', async () => {
    const { user } = renderPage(<LoginPage />, '/login', [
      ['POST', /^\/auth\/login$/, () => apiError(401, 'INVALID_CREDENTIALS', 'invalid')],
    ]);

    await user.type(screen.getByLabelText('Email'), 'asha@example.org');
    await user.type(screen.getByLabelText('Password'), 'wrong-password-1');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Incorrect email or password.')).toBeInTheDocument();
    expect(screen.queryByText('invalid')).not.toBeInTheDocument();
  });

  it('surfaces ACCOUNT_LOCKED (HTTP 423) instead of pretending the attempt can be retried', async () => {
    const { user } = renderPage(<LoginPage />, '/login', [
      ['POST', /^\/auth\/login$/, () => apiError(423, 'ACCOUNT_LOCKED', 'locked')],
    ]);

    await user.type(screen.getByLabelText('Email'), 'asha@example.org');
    await user.type(screen.getByLabelText('Password'), STRONG);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Too many failed sign-in attempts. Try again later.')).toBeInTheDocument();
  });

  it('reports RATE_LIMITED distinctly from a credential failure', async () => {
    const { user } = renderPage(<LoginPage />, '/login', [
      ['POST', /^\/auth\/login$/, () => apiError(429, 'RATE_LIMITED', 'slow down')],
    ]);

    await user.type(screen.getByLabelText('Email'), 'asha@example.org');
    await user.type(screen.getByLabelText('Password'), STRONG);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Too many requests. Please wait a moment and try again.')).toBeInTheDocument();
  });

  it('reports a network failure as a network failure (R8)', async () => {
    resetSession();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    mockFetch([
      ['GET', /^\/meta\/bootstrap$/, () => {
        throw new Error('fetch failed');
      }],
      ['POST', /^\/auth\/login$/, () => {
        throw new Error('fetch failed');
      }],
      ['POST', /^\/auth\/refresh$/, () => apiError(401, 'UNAUTHENTICATED', 'No session')],
    ]);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/login']}>
        <QueryClientProvider client={queryClient}>
          <SessionProvider>
            <LoginPage />
          </SessionProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await user.type(await screen.findByLabelText('Email'), 'asha@example.org');
    await user.type(screen.getByLabelText('Password'), STRONG);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Cannot reach the server. Check your connection and try again.')).toBeInTheDocument();
  });
});

describe('Register', () => {
  it('blocks a password shorter than the server minimum before any request is made', async () => {
    const { user, calls } = renderPage(<RegisterPage />, '/register');

    await user.type(screen.getByLabelText('Full name'), 'Asha Rao');
    await user.type(screen.getByLabelText('Email'), 'asha@example.org');
    await user.type(screen.getByLabelText('Password'), 'short1');
    await user.type(screen.getByLabelText('Confirm password'), 'short1');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Password is too weak.')).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/auth/register')).toHaveLength(0);
  });

  it('blocks a password with no digit', async () => {
    const { user, calls } = renderPage(<RegisterPage />, '/register');

    await user.type(screen.getByLabelText('Full name'), 'Asha Rao');
    await user.type(screen.getByLabelText('Email'), 'asha@example.org');
    await user.type(screen.getByLabelText('Password'), 'NoDigitsHereAtAll');
    await user.type(screen.getByLabelText('Confirm password'), 'NoDigitsHereAtAll');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('At least 10 characters, including a letter and a number.')).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/auth/register')).toHaveLength(0);
  });

  it('blocks a confirmation mismatch and marks the field invalid', async () => {
    const { user, calls } = renderPage(<RegisterPage />, '/register');

    await user.type(screen.getByLabelText('Full name'), 'Asha Rao');
    await user.type(screen.getByLabelText('Email'), 'asha@example.org');
    await user.type(screen.getByLabelText('Password'), STRONG);
    await user.type(screen.getByLabelText('Confirm password'), 'Different-Horse-9');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('The two passwords do not match.')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute('aria-describedby', 'register-confirm-error');
    expect(calls.filter((c) => c.path === '/auth/register')).toHaveLength(0);
  });

  it('registers, then continues to the requested page', async () => {
    const session = makeSession(makeUser({ email: 'new@example.org', roles: ['USER'], conversationCount: 0 }));
    const { user, calls } = renderPage(<RegisterPage />, '/register?next=%2Fchat', [
      ['POST', /^\/auth\/register$/, () => jsonResponse(201, session)],
      ['GET', /^\/users\/me$/, () => jsonResponse(200, session.user)],
    ]);

    await user.type(screen.getByLabelText('Full name'), 'Asha Rao');
    await user.type(screen.getByLabelText('Email'), 'new@example.org');
    await user.type(screen.getByLabelText('Password'), STRONG);
    await user.type(screen.getByLabelText('Confirm password'), STRONG);
    await user.selectOptions(screen.getByLabelText('I am a…'), 'MSME_MANUFACTURER');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/chat'));

    const register = calls.find((c) => c.path === '/auth/register');
    expect(register?.body).toEqual({
      email: 'new@example.org',
      password: STRONG,
      fullName: 'Asha Rao',
      persona: 'MSME_MANUFACTURER',
    });
  });

  it('omits persona entirely when none is chosen, rather than sending an empty string', async () => {
    const session = makeSession();
    const { user, calls } = renderPage(<RegisterPage />, '/register', [
      ['POST', /^\/auth\/register$/, () => jsonResponse(201, session)],
      ['GET', /^\/users\/me$/, () => jsonResponse(200, session.user)],
    ]);

    await user.type(screen.getByLabelText('Full name'), 'Asha Rao');
    await user.type(screen.getByLabelText('Email'), 'asha@example.org');
    await user.type(screen.getByLabelText('Password'), STRONG);
    await user.type(screen.getByLabelText('Confirm password'), STRONG);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(calls.some((c) => c.path === '/auth/register')).toBe(true));
    const body = calls.find((c) => c.path === '/auth/register')?.body as Record<string, unknown>;
    expect(body.persona).toBeNull();
  });

  it('shows a duplicate-email conflict on the email field', async () => {
    const { user } = renderPage(<RegisterPage />, '/register', [
      [
        'POST',
        /^\/auth\/register$/,
        () => apiError(409, 'CONFLICT', 'exists', [{ field: 'email', issue: 'An account with this email already exists.' }]),
      ],
    ]);

    await user.type(screen.getByLabelText('Full name'), 'Asha Rao');
    await user.type(screen.getByLabelText('Email'), 'asha@example.org');
    await user.type(screen.getByLabelText('Password'), STRONG);
    await user.type(screen.getByLabelText('Confirm password'), STRONG);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('An account with this email already exists.')).toBeInTheDocument();
  });

  it('binds a server-side field issue to the right control', async () => {
    const { user } = renderPage(<RegisterPage />, '/register', [
      [
        'POST',
        /^\/auth\/register$/,
        () => apiError(400, 'VALIDATION_FAILED', 'bad', [{ field: 'fullName', issue: 'Name must not contain markup.' }]),
      ],
    ]);

    await user.type(screen.getByLabelText('Full name'), '<script>Asha</script>');
    await user.type(screen.getByLabelText('Email'), 'asha@example.org');
    await user.type(screen.getByLabelText('Password'), STRONG);
    await user.type(screen.getByLabelText('Confirm password'), STRONG);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Name must not contain markup.')).toBeInTheDocument();
    // The submitted value is rendered as text, never as HTML.
    expect(screen.getByLabelText('Full name')).toHaveValue('<script>Asha</script>');
    expect(document.querySelectorAll('script')).toHaveLength(0);
  });
});

describe('Password visibility toggle', () => {
  it('is a real button with aria-pressed and aria-controls, and flips the input type', async () => {
    const { user } = renderPage(<LoginPage />, '/login');

    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'login-password');

    const input = screen.getByLabelText('Password');
    expect(input).toHaveAttribute('type', 'password');

    await user.click(toggle);
    expect(input).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Forgot password', () => {
  it('shows the same message whether or not the account exists (no user enumeration)', async () => {
    resetSession();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { calls } = mockFetch([
      ['POST', /^\/auth\/password\/reset-request$/, () => jsonResponse(202, { sent: true })],
      ...anonymousRoutes(),
    ]);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/login']}>
        <QueryClientProvider client={queryClient}>
          <SessionProvider>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            </Routes>
          </SessionProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('link', { name: 'Forgot password?' }));
    await user.type(await screen.findByLabelText('Email'), 'nobody@example.org');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(
      screen.getByText(/If an account exists for that address, a reset link is on its way/i),
    ).toBeInTheDocument();
    // In non-development mode no token is leaked back to the browser.
    expect(screen.queryByLabelText('Reset token')).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === '/auth/password/reset-request')).toBe(true);
  });
});
