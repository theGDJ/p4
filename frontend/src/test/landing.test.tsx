import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider } from '@/lib/auth';
import { LandingPage } from '@/pages/landing';
import { App } from '@/App';
import i18n from '@/i18n';
import {
  BOOTSTRAP,
  anonymousRoutes,
  apiError,
  jsonResponse,
  mockFetch,
  resetSession,
} from './utils';
import '@/i18n';

/**
 * Landing page (P1 exit criteria): headline, assistant input, example questions,
 * capabilities, and trust/source messaging — all rendered from real server state.
 */

/** Renders the current location so navigation can be asserted precisely. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderLanding(route = '/') {
  resetSession();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[route]}>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <LandingPage />
        </SessionProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('Landing page', () => {
  it('renders the headline and the evidence-first subheadline', async () => {
    mockFetch(anonymousRoutes());
    renderLanding();

    expect(
      await screen.findByRole('heading', { level: 1, name: /Ask about Indian Standards/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/approved knowledge base of official BIS material/i)).toBeInTheDocument();
  });

  it('shows real knowledge-base counts from /meta/bootstrap, never a projected figure', async () => {
    mockFetch([
      [
        'GET',
        /^\/meta\/bootstrap$/,
        () => jsonResponse(200, { ...BOOTSTRAP, knowledge: { approvedDocuments: 42, approvedChunks: 1337, kbVersion: 7 } }),
      ],
      ...anonymousRoutes(),
    ]);
    renderLanding();

    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(screen.getByText('1337')).toBeInTheDocument();
  });

  it('warns that answers will be the R4 fallback when the knowledge base is empty', async () => {
    mockFetch(anonymousRoutes());
    renderLanding();

    expect(await screen.findByText(/The knowledge base is empty in this deployment/i)).toBeInTheDocument();
  });

  it('always shows the R5 informational label', async () => {
    mockFetch(anonymousRoutes());
    renderLanding();

    expect(await screen.findByText('Informational — verify against current official sources')).toBeInTheDocument();
  });

  it('renders all four capabilities and the trust/honesty lists', async () => {
    mockFetch(anonymousRoutes());
    renderLanding();

    expect(await screen.findByRole('heading', { name: 'What it can help with' })).toBeInTheDocument();
    for (const title of ['Standards lookup', 'Certification guidance', 'Hallmarking explained', 'Bilingual']) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    }
    expect(screen.getByRole('heading', { name: 'How the evidence works' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What this tool is not' })).toBeInTheDocument();
    expect(screen.getByText(/It does not certify, approve or decide anything/i)).toBeInTheDocument();
    expect(screen.getByText(/Restricted standards are listed as metadata only/i)).toBeInTheDocument();
  });

  it('fills the assistant input when an example question is chosen', async () => {
    mockFetch(anonymousRoutes());
    const user = userEvent.setup();
    renderLanding();

    const example = await screen.findByRole('button', { name: 'Which Indian Standard applies to drinking water?' });
    await user.click(example);

    const input = screen.getByLabelText(/Ask BIS-Saathi/i) as HTMLInputElement;
    expect(input.value).toBe('Which Indian Standard applies to drinking water?');
  });

  it('carries an anonymous visitor to sign-in with the draft preserved in ?next=', async () => {
    mockFetch(anonymousRoutes());
    const user = userEvent.setup();
    resetSession();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter initialEntries={['/']}>
        <QueryClientProvider client={queryClient}>
          <SessionProvider>
            <LocationProbe />
            <App />
          </SessionProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    const input = await screen.findByLabelText(/Ask BIS-Saathi/i);
    await user.type(input, 'Which IS applies to pressure cookers?');
    await user.click(screen.getByRole('button', { name: /Sign in to ask/i }));

    expect(await screen.findByRole('heading', { level: 1, name: /Sign in to BIS-Saathi/i })).toBeInTheDocument();
    // The draft survives the round trip instead of being thrown away.
    const location = screen.getByTestId('location').textContent ?? '';
    expect(location.startsWith('/login?next=')).toBe(true);
    const next = decodeURIComponent(location.slice('/login?next='.length));
    expect(next).toBe('/chat?q=Which%20IS%20applies%20to%20pressure%20cookers%3F');
  });

  it('shows an error state with retry when bootstrap fails', async () => {
    mockFetch([
      ['POST', /^\/auth\/refresh$/, () => apiError(401, 'UNAUTHENTICATED', 'No session')],
      ['GET', /^\/meta\/bootstrap$/, () => apiError(500, 'INTERNAL', 'Boom')],
    ]);
    renderLanding();

    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
  });

  it('retries bootstrap when the retry button is pressed', async () => {
    let attempts = 0;
    mockFetch([
      [
        'GET',
        /^\/meta\/bootstrap$/,
        () => {
          attempts += 1;
          return attempts === 1
            ? apiError(503, 'UNAVAILABLE', 'Down')
            : jsonResponse(200, { ...BOOTSTRAP, knowledge: { approvedDocuments: 1, approvedChunks: 2, kbVersion: 1 } });
        },
      ],
      ['POST', /^\/auth\/refresh$/, () => apiError(401, 'UNAUTHENTICATED', 'No session')],
    ]);
    const user = userEvent.setup();
    renderLanding();

    await screen.findByText('Something went wrong');
    await user.click(screen.getByRole('button', { name: /Try again/i }));

    expect(await screen.findByText('2')).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('switches the whole page to Hindi without a reload', async () => {
    mockFetch(anonymousRoutes());
    resetSession();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/']}>
        <QueryClientProvider client={queryClient}>
          <SessionProvider>
            <App />
          </SessionProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { level: 1, name: /Ask about Indian Standards/i });
    await user.click(screen.getByRole('radio', { name: 'हिन्दी' }));

    expect(await screen.findByRole('heading', { level: 1, name: /भारतीय मानकों/i })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('hi');
    expect(i18n.language).toBe('hi');
    // The contractual R5 sentence must appear in Hindi, character for character.
    // It legitimately appears twice: once on the landing honesty card and once in
    // the global footer, which is the point — the label is never far away.
    const r5 = screen.getAllByText('सूचनात्मक — कृपया वर्तमान आधिकारिक स्रोतों से सत्यापित करें');
    expect(r5.length).toBeGreaterThanOrEqual(2);
  });
});
