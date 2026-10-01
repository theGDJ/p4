import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '@/i18n';
import { AdminKnowledgePage } from '@/pages/admin-knowledge';
import { apiError, authenticatedRoutes, jsonResponse, makeUser, mockFetch, renderWithProviders } from './utils';
import type { IngestionJob } from '@/lib/types';

/**
 * The P2 admin surface, tested against the documented shapes of docs/API.md.
 *
 * These are the interactions where a friendly UI would lie: an ingest that is only
 * *queued* shown as saved, a chunk approved without the reviewer's reason reaching the
 * server, a 409 "superseded" swallowed into a green tick, a 429 presented as a crash.
 */

function makeJob(overrides: Partial<IngestionJob> = {}): IngestionJob {
  return {
    id: 'job_1',
    documentId: 'doc_1',
    documentVersionId: 'ver_1',
    sourceKind: 'manual',
    sourceLabel: null,
    state: 'DONE',
    stage: 'DONE',
    error: null,
    warnings: [],
    attempts: 1,
    maxAttempts: 3,
    retryable: false,
    needsResubmit: true,
    chunksProduced: 2,
    requestedBy: 'usr_test',
    createdAt: '2026-10-01T10:00:00.000Z',
    startedAt: '2026-10-01T10:00:01.000Z',
    finishedAt: '2026-10-01T10:00:02.000Z',
    ...overrides,
  };
}

const CHUNK = {
  id: 'chk_1',
  documentId: 'doc_1',
  documentVersionId: 'ver_1',
  ordinal: 1,
  title: 'IS 10500:2012 Stainless Steel Sheet and Plate',
  standardNo: 'IS 10500:2012',
  section: '4.2',
  headingPath: 'IS 10500:2012 > 4 Requirements > 4.2 Chemical Composition',
  docType: 'STANDARD',
  language: 'en',
  sourceUrl: null,
  publishedDate: null,
  revisedDate: null,
  verificationStatus: 'UNVERIFIED',
  reviewState: 'PENDING_REVIEW',
  reviewedAt: null,
  verifiedAt: null,
  tokenCount: 88,
  contentHash: 'a'.repeat(64),
  embeddingModel: 'mock-multilingual-1',
  embeddedAt: '2026-10-01T10:00:02.000Z',
  hasEmbedding: true,
  embeddingDimensions: 1024,
  pages: [],
  firstLine: 4,
  lastLine: 6,
  overlapTokens: 24,
  injectionFlags: [{ rule: 'IGNORE_PREVIOUS_INSTRUCTIONS', severity: 'HIGH', excerpt: 'ignore previous instructions' }],
  preview: 'The material shall conform to the chemical composition specified in Table 1.',
};

function adminRoutes(job: IngestionJob = makeJob()) {
  const routes = authenticatedRoutes(makeUser({ roles: ['USER', 'CONTENT_MANAGER'] }));
  return [
    ...routes,
    ['GET', /^\/admin\/knowledge\/chunks\?/, () => jsonResponse(200, { items: [CHUNK], total: 1, pendingReview: 1 })],
    ['GET', /^\/admin\/knowledge\/chunks\/chk_1$/, () => jsonResponse(200, { ...CHUNK, content: 'The material shall conform to the chemical composition specified in Table 1.' })],
    ['POST', /^\/admin\/knowledge\/chunks\/chk_1\/approve$/, () => jsonResponse(200, { ...CHUNK, reviewState: 'APPROVED' })],
    ['POST', /^\/admin\/knowledge\/chunks\/chk_1\/reject$/, () => jsonResponse(200, { ...CHUNK, reviewState: 'REJECTED' })],
    ['POST', /^\/admin\/ingestion\/text$/, () => jsonResponse(202, { accepted: true, job, poll: `/api/v1/admin/ingestion/jobs/${job.id}` })],
    ['POST', /^\/admin\/ingestion\/manifest$/, () => jsonResponse(202, { accepted: true, queued: [], rejected: [{ line: 2, field: 'source_url', reason: 'An open item needs a source URL.' }], deferredRows: 0, columns: ['source_url'] })],
    ['GET', /^\/admin\/ingestion\/jobs\?|^\/admin\/ingestion\/jobs$/, () => jsonResponse(200, { items: [job, makeJob({ id: 'job_2', state: 'FAILED', stage: 'FETCH', error: 'Fetch was refused by policy: the address is not publicly reachable.', retryable: true, needsResubmit: false, warnings: [] })], total: 2, failed: 1, queued: 0 })],
    ['GET', /^\/admin\/ingestion\/jobs\/job_1$/, () => jsonResponse(200, job)],
    ['POST', /^\/admin\/ingestion\/jobs\/job_2\/retry$/, () => jsonResponse(200, { message: 'Re-queued the job.', job: makeJob({ id: 'job_2', state: 'QUEUED' }) })],
    ['GET', /^\/admin\/knowledge\/sources\/freshness$/, () => jsonResponse(200, { items: [], total: 0, recheckable: 0, changed: 0, linkRot: 0, neverChecked: 0 })],
    ['POST', /^\/admin\/knowledge\/sources\/check-freshness$/, () => jsonResponse(200, { checked: 0, durationMs: 1, results: [], note: 'A changed or dead source is flagged for review; approved text is never replaced automatically.' })],
    ['GET', /^\/admin\/knowledge\/gaps$/, () => jsonResponse(200, { items: [{ intent: 'factual', topic: 'cryogenic impact testing', count: 2, distinctQuestions: 1, languages: ['en'], firstSeenAt: '2026-10-01T09:00:00.000Z', lastSeenAt: '2026-10-01T09:30:00.000Z', examples: [{ queryText: 'Which standard covers cryogenic impact testing?', language: 'en', occurredAt: '2026-10-01T09:30:00.000Z' }] }], total: 2, note: 'It is a count of stored questions, not of demand.' })],
    ['GET', /^\/admin\/feedback$/, () => jsonResponse(200, { items: [{ id: 'fb_1', userId: 'usr_test', messageId: 'msg_1', conversationId: 'cnv_1', helpful: false, rating: null, issueType: 'WRONG_ANSWER', comment: 'The clause number is wrong.', resolved: false, createdAt: '2026-10-01T09:00:00.000Z' }], total: 1, open: 1, note: 'Candidates for the golden evaluation set.' })],
  ] as ReturnType<typeof authenticatedRoutes>;
}

describe('the knowledge admin page', () => {
  it('lists pending chunks with their flags, and says plainly that they are not retrievable', async () => {
    mockFetch(adminRoutes());
    renderWithProviders(<AdminKnowledgePage />, { route: '/admin/knowledge' });

    expect(await screen.findByText(/1 chunk\(s\) pending review/i)).toBeInTheDocument();
    expect(screen.getByText('IS 10500:2012 Stainless Steel Sheet and Plate')).toBeInTheDocument();
    expect(screen.getByText(/1 injection-like string/i)).toBeInTheDocument();
    expect(screen.getByText('The material shall conform to the chemical composition specified in Table 1.')).toBeInTheDocument();

    // The honest framing: this list is work to do, not a search index.
    expect(screen.getByText(/an approval is what makes a sentence quotable/i)).toBeInTheDocument();
  });

  it('sends the reviewer note with an approval, and reports what the approval published', async () => {
    const calls = mockFetch(adminRoutes());
    renderWithProviders(<AdminKnowledgePage />, { route: '/admin/knowledge' });

    await userEvent.click(await screen.findByRole('button', { name: /^Review$/ }));
    const dialog = await screen.findByRole('dialog');
    const note = within(dialog).getByLabelText(/Reviewer note/i);
    await userEvent.type(note, 'Checked against the printed copy.');

    await userEvent.click(within(dialog).getByRole('button', { name: /Approve for retrieval/i }));

    const approval = calls.calls.find((call) => call.method === 'POST' && call.path.endsWith('/approve'));
    expect(approval).toBeDefined();
    expect(approval!.body).toEqual({ note: 'Checked against the printed copy.' });
    // The dialog closes on success rather than claiming anything the server did not say.
    await screen.findByText(/1 chunk\(s\) pending review/i);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('surfaces a 409 "superseded version" instead of swallowing it (R8)', async () => {
    // mockFetch is first-match-wins, so the override goes in front of the defaults.
    mockFetch([
      [
        'POST',
        /^\/admin\/knowledge\/chunks\/chk_1\/approve$/,
        () => apiError(409, 'CONFLICT', 'This version was superseded; approve the current version instead.'),
      ],
      ...adminRoutes(),
    ] as ReturnType<typeof adminRoutes>);
    renderWithProviders(<AdminKnowledgePage />, { route: '/admin/knowledge' });

    await userEvent.click(await screen.findByRole('button', { name: /^Review$/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /Approve for retrieval/i }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/superseded/i);
  });

  it('renders a throttled submission as a rate limit, with the server message', async () => {
    mockFetch([
      ...adminRoutes(),
      ['POST', /^\/admin\/ingestion\/url$/, () => apiError(429, 'RATE_LIMITED', 'Too many submissions. Try again in 5 seconds.')],
    ]);
    renderWithProviders(<AdminKnowledgePage />, { route: '/admin/knowledge' });

    await userEvent.click(await screen.findByRole('button', { name: /Fetch a URL/i }));
    const title = await screen.findByLabelText(/Document title/i);
    await userEvent.type(title, 'IS 4029:2010');
    await userEvent.type(screen.getByLabelText(/Source URL/i), 'https://www.bis.gov.in/standards/is-4029');
    await userEvent.click(screen.getByRole('button', { name: /Queue this submission/i }));

    expect(await screen.findByText(/Too many submissions\. Try again in 5 seconds\./i)).toBeInTheDocument();
    // A rate limit is not a saved document and not a crash.
    expect(screen.queryByText(/saved|complete/i)).toBeNull();
  });

  it('shows job warnings on the submission panel, including the metadata-only case', async () => {
    mockFetch(
      adminRoutes(
        makeJob({
          warnings: [
            'Access level RESTRICTED: only metadata was stored. The document text was not fetched (R11).',
            'Embeddings came from the offline hashing provider: they are stored so the column is honest, but they are not semantically meaningful.',
          ],
        }),
      ),
    );
    renderWithProviders(<AdminKnowledgePage />, { route: '/admin/knowledge' });

    await userEvent.type(await screen.findByLabelText(/Document title/i), 'IS 10500:2012');
    await userEvent.type(screen.getByLabelText(/Text to ingest/i), 'The material shall conform to the chemical composition specified in Table 1 for grades 304 and 316, and the carbon content shall not exceed 0.08 percent by mass.');
    await userEvent.click(screen.getByRole('button', { name: /Queue this submission/i }));

    // The same warning legitimately appears twice — on the submission panel and in the
    // job monitor — so assert "shown at all, everywhere it belongs" rather than one.
    expect((await screen.findAllByText(/only metadata was stored/i)).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/not semantically meaningful/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/2 chunk\(s\) produced/i)).toBeInTheDocument();
  });

  it('marks a settled job as done and offers retry only where the server says it is retryable', async () => {
    const calls = mockFetch(adminRoutes());
    renderWithProviders(<AdminKnowledgePage />, { route: '/admin/knowledge' });

    expect(await screen.findByText(/Fetch was refused by policy/i)).toBeInTheDocument();
    const retry = await screen.findByRole('button', { name: /Retry now/i });
    await userEvent.click(retry);
    expect(calls.calls.some((call) => call.method === 'POST' && call.path === '/admin/ingestion/jobs/job_2/retry')).toBe(true);

    // job_1 finished and is not retryable, so it gets no button of its own.
    expect(screen.getAllByRole('button', { name: /Retry now/i })).toHaveLength(1);
    expect(screen.getByText(/Not retryable/i)).toBeInTheDocument();
  });

  it('reports the freshness sweep in its own words: a flag is not a re-ingest', async () => {
    mockFetch(adminRoutes());
    renderWithProviders(<AdminKnowledgePage />, { route: '/admin/knowledge' });

    await userEvent.click(await screen.findByRole('button', { name: /Run a check now/i }));
    // The sweep's own words, and they echo the panel's standing caveat rather than
    // inventing a friendlier "updated automatically" outcome.
    expect(await screen.findByText(/0 source\(s\) checked/i)).toBeInTheDocument();
    expect(screen.getAllByText(/never replaced automatically/i).length).toBeGreaterThanOrEqual(2);
  });

  it('shows the gaps list with the count-of-questions caveat, and the open feedback queue', async () => {
    mockFetch(adminRoutes());
    renderWithProviders(<AdminKnowledgePage />, { route: '/admin/knowledge' });

    // The group label and the example question both contain the phrase; both are the API's.
    expect((await screen.findAllByText(/cryogenic impact testing/i)).length).toBeGreaterThan(1);
    // R10: the panel must not upgrade "we stored this question" into "many people want this".
    expect(screen.getByText(/count of stored questions/i)).toBeInTheDocument();
    expect(screen.getByText(/Candidates for the golden evaluation set/i)).toBeInTheDocument();
  });

  it('has Hindi copy for every string on this page', async () => {
    mockFetch(adminRoutes());
    await i18n.changeLanguage('hi');
    try {
      renderWithProviders(<AdminKnowledgePage />, { route: '/admin/knowledge' });
      expect(await screen.findByRole('heading', { level: 1, name: 'ज्ञान-कोष भर्ती और समीक्षा' })).toBeInTheDocument();
      // Awaited like every other query here: the queue row arrives from a fetch, and an
      // un-awaited getBy* would race it.
      expect(await screen.findByRole('button', { name: 'समीक्षा करें' })).toBeInTheDocument();
      expect(screen.getByText('समीक्षा कतार')).toBeInTheDocument();
      // No untranslated key may leak through as its own name.
      const leaked = /[A-Za-z]+\.[A-Za-z.]*adminKnowledge\.[A-Za-z.]+|adminKnowledge\.[A-Za-z.]+/.exec(document.body.textContent ?? '');
      expect(leaked?.[0] ?? null, document.body.textContent?.slice(0, 400)).toBeNull();
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
