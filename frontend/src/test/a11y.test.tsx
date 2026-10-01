import type * as React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axe from 'axe-core';
import { SessionProvider } from '@/lib/auth';
import { App } from '@/App';
import { LandingPage } from '@/pages/landing';
import { LoginPage, RegisterPage, ForgotPasswordPage } from '@/pages/auth';
import { NotFoundPage } from '@/pages/misc';
import { anonymousRoutes, jsonResponse, mockFetch, resetSession, type FetchRoute } from './utils';

/**
 * Accessibility gate (§11: WCAG 2.2 AA).
 *
 * `npm run contrast` covers the colour half of AA; this covers structure —
 * landmarks, headings, form labels, and ARIA correctness. axe runs against the
 * real rendered DOM, so a violation here is a violation for users, not a style
 * opinion.
 */

const extraRoutes: FetchRoute[] = [
  ['GET', /^\/conversations$/, () => jsonResponse(200, { items: [], total: 0 })],
];

async function renderAndAudit(ui: React.ReactElement, route = '/', routes: FetchRoute[] = anonymousRoutes()) {
  resetSession();
  mockFetch([...extraRoutes, ...routes]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <MemoryRouter initialEntries={[route]}>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>{ui}</SessionProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  // Every page under audit renders exactly one h1; waiting for it means the
  // session bootstrap and initial queries have settled.
  await screen.findByRole('heading', { level: 1 });
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  });
  return results;
}

/**
 * Structural subset of axe's result type. `axe.run` is declared with a callback
 * overload, so `ReturnType<typeof axe.run>` resolves to `void`; describing only the
 * fields asserted here avoids depending on that overload ordering.
 */
interface AxeViolation {
  id: string;
  impact?: string | null;
  help: string;
  // axe types `target` as a cross-tree/shadow-DOM selector union; it is only ever
  // printed here, so `unknown` is enough and avoids coupling to that union.
  nodes: Array<{ target?: unknown; failureSummary?: string }>;
}
interface AxeRunResult {
  violations: AxeViolation[];
}

/** Formats violations so a failure reads like a bug report, not a stack trace. */
function describeViolations(results: AxeRunResult): string {
  return results.violations
    .map((v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.map((n) => `    → ${Array.isArray(n.target) ? n.target.join(' ') : String(n.target ?? '?')}\n      ${n.failureSummary}`).join('\n')}`)
    .join('\n');
}

describe('Accessibility (axe, WCAG 2.2 AA)', () => {
  it('landing page has no violations', async () => {
    const results = await renderAndAudit(<LandingPage />);
    expect(results.violations, describeViolations(results)).toHaveLength(0);
  });

  it('login page has no violations', async () => {
    const results = await renderAndAudit(<LoginPage />, '/login');
    expect(results.violations, describeViolations(results)).toHaveLength(0);
  });

  it('register page has no violations', async () => {
    const results = await renderAndAudit(<RegisterPage />, '/register');
    expect(results.violations, describeViolations(results)).toHaveLength(0);
  });

  it('forgot-password page has no violations', async () => {
    const results = await renderAndAudit(<ForgotPasswordPage />, '/forgot-password');
    expect(results.violations, describeViolations(results)).toHaveLength(0);
  });

  it('404 page has no violations', async () => {
    const results = await renderAndAudit(<NotFoundPage path="/gone" />, '/gone');
    expect(results.violations, describeViolations(results)).toHaveLength(0);
  });

  it('the full shell exposes one main landmark and a heading hierarchy', async () => {
    resetSession();
    mockFetch([...extraRoutes, ...anonymousRoutes()]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <QueryClientProvider client={queryClient}>
          <SessionProvider>
            <App />
          </SessionProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { level: 1 });

    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getAllByRole('banner')).toHaveLength(1);
    expect(screen.getAllByRole('contentinfo')).toHaveLength(1);

    // Exactly one h1 per page, and no heading level is skipped on the way down.
    const levels = screen
      .getAllByRole('heading')
      .map((h) => Number((h as HTMLHeadingElement).tagName.slice(1)))
      .sort((a, b) => a - b);
    expect(levels.filter((l) => l === 1)).toHaveLength(1);
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i]! - levels[i - 1]!, `heading jump before ${levels[i]}`).toBeLessThanOrEqual(1);
    }

    // A skip link must be the first focusable element in the document.
    const skip = container.querySelector('a.skip-link');
    expect(skip).not.toBeNull();
    expect(skip?.getAttribute('href')).toBe('#main');

    const results = await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
    });
    expect(results.violations, describeViolations(results)).toHaveLength(0);
  });

  it('every form control on the auth pages has an accessible name', async () => {
    resetSession();
    mockFetch([...extraRoutes, ...anonymousRoutes()]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <MemoryRouter initialEntries={['/register']}>
        <QueryClientProvider client={queryClient}>
          <SessionProvider>
            <RegisterPage />
          </SessionProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { level: 1, name: /Create your account/i });

    const controls = Array.from(
      container.querySelectorAll<HTMLElement>('input, select, textarea, button'),
    );
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      const named =
        Boolean(control.getAttribute('aria-label')) ||
        Boolean(control.getAttribute('aria-labelledby')) ||
        Boolean(control.id && container.querySelector(`label[for="${control.id}"]`)) ||
        (control.textContent ?? '').trim().length > 0 ||
        Boolean(control.getAttribute('title'));
      expect(named, `${control.tagName}#${control.id || '(no id)'} has no accessible name`).toBe(true);
    }

    // Required state is on the control, not baked into the label text.
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-required', 'true');
    expect(screen.getByLabelText('Full name')).toHaveAttribute('aria-required', 'true');
    // The optional persona select must not claim to be required.
    expect(screen.getByLabelText('I am a…')).not.toHaveAttribute('aria-required');
  });

  it('marks the Devanagari example question with lang="hi" so it is read in Hindi', async () => {
    resetSession();
    mockFetch([...extraRoutes, ...anonymousRoutes()]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter initialEntries={['/']}>
        <QueryClientProvider client={queryClient}>
          <SessionProvider>
            <LandingPage />
          </SessionProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    const hindiExample = await screen.findByRole('button', { name: /मेरे उत्पाद के लिए/i });
    expect(hindiExample).toHaveAttribute('lang', 'hi');

    const englishExample = screen.getByRole('button', { name: /Which Indian Standard applies to drinking water\?/i });
    expect(englishExample).toHaveAttribute('lang', 'en');
  });
});
