import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { BASE, askSse, newApp, newConversation, registerSession, startFakeProvider, useProviderConfig, type Session } from './helpers';
import type { Store } from '../src/db/store';
import { resetProviders } from '../src/rag/providers';
import { resetAnswerCache, answerCacheEntryCount } from '../src/lib/answerCache';
import { resetEmbeddingCache } from '../src/rag/embedCache';
import { resetConfig, setConfigForTests, loadConfig } from '../src/config';
import { AUDIT_ACTIONS } from '../src/lib/audit';
import { knowledgeChunks } from '../src/db/store';
import { resetIngestThrottleForTests } from '../src/modules/ingestion/routes';

/**
 * P2 §5/§6 — the admin HTTP surface: who may ingest, what the queue says, how review
 * works, and what is never exposed. These tests run against the same Express app the
 * frontend talks to, so the contract in docs/API.md is being checked, not described.
 */

const TEXT = [
  '# IS 10500:2012 Stainless Steel Sheet and Plate',
  '## 4 Requirements',
  '### 4.2 Chemical Composition',
  'The material shall conform to the chemical composition specified in Table 1.',
  'For grades 304 and 316, the carbon content shall not exceed 0.08 percent by mass.',
  'The phosphorus content shall not exceed 0.045 percent and the sulphur content 0.030 percent by mass.',
].join('\n\n');

let ctx: { app: ReturnType<typeof newApp>['app']; store: ReturnType<typeof newApp>['store'] };
let manager: Session;
let user: Session;

/**
 * Registers through the public API on a *given* app and store, then grants the extra
 * roles directly. `newSession()` builds its own app, which would leave the user
 * registered somewhere other than the app under test — every request would then 401
 * for the wrong reason.
 */
async function sessionIn(app: Parameters<typeof registerSession>[0], store: Store, fullName: string, roles?: string[]): Promise<Session> {
  const session = await registerSession(app, { fullName });
  session.store = store;
  if (roles) {
    const row = store.users.rows.get(session.userId);
    if (row) row.roles = roles as typeof row.roles;
  }
  return session;
}

type HttpMethod = 'get' | 'post' | 'put' | 'delete';

function auth(session: Session, method: HttpMethod, url: string, csrf = true) {
  const call = request(session.app)[method](url).set('Authorization', `Bearer ${session.accessToken}`);
  return csrf ? call.set('X-XSRF-TOKEN', session.csrfToken) : call;
}

/** The queue is asynchronous by design, so the test polls like a client would. */
async function waitForJob(session: Session, jobId: string, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await auth(session, 'get', `${BASE}/admin/ingestion/jobs/${jobId}`).expect(200);
    const job = res.body as { state: string };
    if (job.state === 'DONE' || job.state === 'FAILED' || Date.now() > deadline) return res.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(async () => {
  resetConfig();
  setConfigForTests(
    loadConfig({
      ...process.env,
      LLM_PROVIDER: 'mock',
      EMBEDDING_PROVIDER: 'mock',
      ANSWER_CACHE_ENABLED: 'true',
      INGEST_ALLOW_PRIVATE_NETWORKS: 'true',
    } as NodeJS.ProcessEnv),
  );
  resetProviders();
  resetAnswerCache();
  resetEmbeddingCache();
  resetIngestThrottleForTests();
  ctx = newApp();
  manager = await sessionIn(ctx.app, ctx.store, 'Content Manager', ['USER', 'CONTENT_MANAGER']);
  user = await sessionIn(ctx.app, ctx.store, 'Plain User');
});

afterEach(() => {
  resetConfig();
  setConfigForTests(undefined);
  resetProviders();
  resetAnswerCache();
  // Leave no tokens spent for the next test in this file, and none for the next file
  // that runs in this worker.
  resetIngestThrottleForTests();
});

describe('who may ingest', () => {
  it('an anonymous caller gets 401, and a signed-in USER gets 403 — not a 404 to hide the route', async () => {
    await request(ctx.app).get(`${BASE}/admin/ingestion/jobs`).expect(401);
    await request(ctx.app).post(`${BASE}/admin/ingestion/text`).send({ content: TEXT, title: 'x' }).expect(401);
    await auth(user, 'get', `${BASE}/admin/ingestion/jobs`).expect(403);
    await auth(user, 'get', `${BASE}/admin/knowledge/stats`).expect(403);
  });

  it('the admin API is Bearer-only, so a request that only carries cookies is refused', async () => {
    // CSRF protection is applied to the cookie-authenticated endpoints (`/auth/refresh`,
    // `/auth/logout`) — the places where a browser sends the credential on its own. The
    // admin and chat routes require an Authorization header that a cross-site form
    // cannot supply, and they never accept the refresh cookie as authentication, so this
    // request fails on the missing token before its body is looked at.
    const res = await request(ctx.app)
      .post(`${BASE}/admin/ingestion/text`)
      .set('X-XSRF-TOKEN', manager.csrfToken)
      .send({ content: TEXT, title: 'IS 10500', docType: 'STANDARD', language: 'en' })
      .expect(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
    expect([...ctx.store.ingestionJobs.rows.values()]).toHaveLength(0);

    // And where cookies *are* the credential, the missing CSRF header is the refusal.
    const refresh = await request(ctx.app)
      .post(`${BASE}/auth/refresh`)
      .set('Cookie', `bs_refresh=${manager.refreshToken}`)
      .expect(403);
    expect((refresh.body as { error: { code: string } }).error.code).toBe('CSRF_FAILED');
  });

  it('a CONTENT_MANAGER can queue a job and poll it to DONE', async () => {
    const res = await auth(manager, 'post', `${BASE}/admin/ingestion/text`)
      .send({ content: TEXT, title: 'IS 10500:2012', docType: 'STANDARD', language: 'en', standardNo: 'IS 10500:2012', publisher: 'BIS' })
      .expect(202);

    const body = res.body as { accepted: boolean; job: { id: string; state: string }; poll: string };
    expect(body.accepted).toBe(true);
    // 202 + a poll URL: ingestion is never synchronous behind a request that can time
    // out. Which of the two queue states the client sees depends on how far the job got
    // while the response was being written, so the contract is "queued, not finished".
    expect(['QUEUED', 'RUNNING']).toContain(body.job.state);
    expect(body.poll).toBe(`${BASE.replace(/\/$/, '')}/admin/ingestion/jobs/${body.job.id}`.replace('/api/v1', '/api/v1'));

    const done = (await waitForJob(manager, body.job.id)) as {
      state: string;
      chunksProduced: number;
      documentVersionId: string;
      warnings: string[];
    };
    expect(done.state).toBe('DONE');
    expect(done.chunksProduced).toBeGreaterThan(0);

    const list = await auth(manager, 'get', `${BASE}/admin/ingestion/jobs`).expect(200);
    const listed = list.body as { total: number; items: Array<{ id: string; state: string }> };
    expect(listed.total).toBe(1);
    expect(listed.items[0]!.id).toBe(body.job.id);
  });

  it('refuses a body that does not satisfy the contract, and says which field', async () => {
    const res = await auth(manager, 'post', `${BASE}/admin/ingestion/text`)
      .send({ text: 'short', title: '', docType: 'WISHFUL', language: 'de' })
      .expect(400);
    const body = res.body as { error: { code: string; details?: Array<{ field: string; issue: string }> } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    const paths = (body.error.details ?? []).map((d) => d.field);
    expect(paths).toEqual(expect.arrayContaining(['title', 'docType', 'language']));
    expect([...ctx.store.ingestionJobs.rows.values()]).toHaveLength(0);
  });
});

describe('review before searchable (R7)', () => {
  async function ingestAndListChunks() {
    const res = await auth(manager, 'post', `${BASE}/admin/ingestion/text`)
      .send({ content: TEXT, title: 'IS 10500:2012', docType: 'STANDARD', language: 'en', standardNo: 'IS 10500:2012', publisher: 'BIS' })
      .expect(202);
    const job = await waitForJob(manager, (res.body as { job: { id: string } }).job.id);
    const versionId = (job as { documentVersionId: string }).documentVersionId;
    const chunks = await auth(manager, 'get', `${BASE}/admin/knowledge/chunks?reviewState=PENDING_REVIEW&limit=50`).expect(200);
    return { versionId, chunks: (chunks.body as { items: Array<Record<string, unknown>> }).items, job: job as Record<string, unknown> };
  }

  it('lists pending chunks with provenance and without vectors', async () => {
    const { chunks } = await ingestAndListChunks();
    expect(chunks.length).toBeGreaterThan(0);
    const first = chunks[0]!;
    expect(first.reviewState).toBe('PENDING_REVIEW');
    expect(first.tokenCount).toBeGreaterThan(0);
    expect(first.headingPath).toContain('Chemical Composition');
    // The content hash is exposed on purpose: it is how the review UI can show that two
    // submissions are the same text (R2). A vector is not — 1024 floats nobody can read,
    // and publishing them lets a client probe the corpus by similarity (§9).
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toHaveProperty('embedding');
    expect(first).not.toHaveProperty('vector');
    expect(first.hasEmbedding).toBe(true);
    expect(first.embeddingDimensions).toBeGreaterThan(0);

    // The list is a work queue, so the body text comes from the detail endpoint.
    const detail = await auth(manager, 'get', `${BASE}/admin/knowledge/chunks/${first.id as string}`).expect(200);
    expect((detail.body as { content: string }).content).toContain('Chemical Composition');
  });

  it('makes a chunk searchable only when a person approves it, and records who', async () => {
    const { chunks, versionId } = await ingestAndListChunks();
    const before = ctx.store.kbVersion;
    const stats = await auth(manager, 'get', `${BASE}/admin/knowledge/stats`).expect(200);
    expect((stats.body as { pendingChunks: number }).pendingChunks).toBe(chunks.length);

    const approved = await auth(manager, 'post', `${BASE}/admin/knowledge/chunks/${chunks[0]!.id as string}/approve`)
      .send({ note: 'Checked against the printed copy.' })
      .expect(200);
    expect((approved.body as { reviewState: string }).reviewState).toBe('APPROVED');
    expect(ctx.store.kbVersion).toBe(before + 1);

    const audit = [...ctx.store.auditLogs.rows.values()].filter((row) => row.action === AUDIT_ACTIONS.KNOWLEDGE_CHUNK_APPROVED);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorUserId).toBe(manager.userId);
    expect(audit[0]!.entityId).toBe(chunks[0]!.id);

    // The version as a whole still needs approval for the rest, and until then only the
    // approved chunk is retrievable.
    expect(knowledgeChunks.retrievable(ctx.store)).toHaveLength(1);

    const versionApproval = await auth(manager, 'post', `${BASE}/admin/knowledge/documents/${chunks[0]!.documentId as string}/versions/${versionId}/approve`)
      .send({})
      .expect(200);
    // This fixture is six short lines, which the chunker keeps as one block; what
    // matters is that approving the version publishes exactly what was listed.
    expect((versionApproval.body as { approved: number }).approved).toBe(chunks.length);
    expect((versionApproval.body as { kbVersion: number }).kbVersion).toBe(ctx.store.kbVersion);
    expect(knowledgeChunks.retrievable(ctx.store)).toHaveLength(chunks.length);
  });

  it('rejecting a version keeps the rows for audit and takes them out of the index', async () => {
    const { chunks, versionId } = await ingestAndListChunks();
    const res = await auth(manager, 'post', `${BASE}/admin/knowledge/documents/${chunks[0]!.documentId as string}/versions/${versionId}/reject`)
      .send({ note: 'Wrong edition.' })
      .expect(200);
    expect((res.body as { rejected: number }).rejected).toBe(chunks.length);
    expect(knowledgeChunks.retrievable(ctx.store)).toHaveLength(0);
    const listed = await auth(manager, 'get', `${BASE}/admin/knowledge/chunks?reviewState=REJECTED&limit=50`).expect(200);
    expect((listed.body as { total: number }).total).toBe(chunks.length);
  });

  it('refuses to approve a chunk from a superseded version, with a message that says what to do instead', async () => {
    const { chunks, versionId } = await ingestAndListChunks();
    await auth(manager, 'post', `${BASE}/admin/knowledge/documents/${chunks[0]!.documentId as string}/versions/${versionId}/reject`).send({ note: 'Superseded by a later edition.' }).expect(200);
    // Ingest a second version, which supersedes the first.
    const second = await auth(manager, 'post', `${BASE}/admin/ingestion/text`)
      .send({ content: `${TEXT}\n\nOne more requirement about marking.`, title: 'IS 10500:2012', docType: 'STANDARD', language: 'en', standardNo: 'IS 10500:2012', publisher: 'BIS', documentId: chunks[0]!.documentId as string })
      .expect(202);
    await waitForJob(manager, (second.body as { job: { id: string } }).job.id);

    const stale = await auth(manager, 'get', `${BASE}/admin/knowledge/chunks?reviewState=REJECTED&limit=50`).expect(200);
    const staleChunk = (stale.body as { items: Array<{ id: string }> }).items[0]!;
    const refused = await auth(manager, 'post', `${BASE}/admin/knowledge/chunks/${staleChunk.id}/approve`).send({}).expect(409);
    expect((refused.body as { error: { message: string } }).error.message).toMatch(/superseded/i);
  });
});

describe('the manifest endpoint', () => {
  it('reports queued, deferred and rejected rows separately', async () => {
    const header = 'source_url,title,doc_type,publisher,access,license_note,language,status,standard_no';
    const csv = [
      header,
      `,IS 10500:2012 Plate,standard,BIS,open,Public notice,en,approved,IS 10500:2012`,
      ',IS 4029 Steel,standard,BIS,restricted,BIS licence 12,en,approved,IS 4029:2010',
      'https://example.com/is-9999,IS 9999 Draft,standard,BIS,open,notice,en,draft,IS 9999',
      ',Bad row,mystery,BIS,open,notice,en,approved,',
    ].join('\n');
    const res = await auth(manager, 'post', `${BASE}/admin/ingestion/manifest`)
      .send({ csv })
      .expect(202);
    const body = res.body as { accepted: boolean; queued: unknown[]; rejected: Array<{ line: number; field?: string; reason: string }>; deferredRows: number; columns: string[] };
    expect(body.accepted).toBe(true);
    // Exactly what the manifest policy promises: the open row with no URL and the row
    // with an unknown doc_type are refused; the restricted row is queued metadata-only
    // (R11 — never fetched); the draft row is ingested but not published, so it shows up
    // as deferred rather than as an error somebody has to re-submit.
    expect(body.queued).toHaveLength(1);
    expect(body.deferredRows).toBe(1);
    expect(body.rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 2, field: 'source_url' }),
        expect.objectContaining({ line: 5, field: 'doc_type' }),
      ]),
    );
    expect(body.rejected).toHaveLength(2);
    // The reasons name the fix, in the file's own words, not a stack trace.
    expect(body.rejected[0]!.reason).toMatch(/source URL/i);
    expect(body.columns).toContain('source_url');
  });

  it('a restricted row is recorded without content, and says so', async () => {
    const res = await auth(manager, 'post', `${BASE}/admin/ingestion/text`)
      .send({
        content: TEXT,
        title: 'IS 4029:2010 Steel Plate',
        docType: 'STANDARD',
        language: 'en',
        standardNo: 'IS 4029:2010',
        publisher: 'BIS',
        accessLevel: 'restricted',
        licenseNote: 'Sold by BIS; storing the text is not permitted.',
      })
      .expect(202);
    const job = (await waitForJob(manager, (res.body as { job: { id: string } }).job.id)) as {
      state: string;
      chunksProduced: number;
      documentId: string;
      warnings: string[];
    };
    expect(job.state).toBe('DONE');
    expect(job.chunksProduced).toBe(0);
    expect(job.warnings.join(' ')).toMatch(/metadata only/i);

    const doc = await auth(manager, 'get', `${BASE}/admin/knowledge/documents/${job.documentId}`).expect(200);
    expect((doc.body as { accessLevel: string; verificationStatus: string }).accessLevel).toBe('restricted');
    expect((doc.body as { verificationStatus: string }).verificationStatus).toBe('RESTRICTED');
    const listed = await auth(manager, 'get', `${BASE}/admin/knowledge/chunks?documentId=${job.documentId}`).expect(200);
    expect((listed.body as { total: number }).total).toBe(0);
  });
});

describe('freshness, gaps and feedback', () => {
  it('reports the freshness state of what is checkable, and skips what is not', async () => {
    const res = await auth(manager, 'post', `${BASE}/admin/ingestion/text`)
      .send({ content: TEXT, title: 'IS 10500:2012', docType: 'STANDARD', language: 'en', publisher: 'BIS' })
      .expect(202);
    await waitForJob(manager, (res.body as { job: { id: string } }).job.id);

    const freshness = await auth(manager, 'get', `${BASE}/admin/knowledge/sources/freshness`).expect(200);
    const items = (freshness.body as {
      items: Array<{ lastCheckOutcome: string | null; url: string | null; recheckable: boolean; checksum: string | null }>;
    }).items;
    expect(items.length).toBeGreaterThan(0);
    // A manual entry has nothing to re-check; it is reported as such rather than as a
    // failure that would page somebody at 3am.
    expect(items.every((i) => typeof i.recheckable === 'boolean')).toBe(true);

    const sweep = await auth(manager, 'post', `${BASE}/admin/knowledge/sources/check-freshness`).send({}).expect(200);
    expect((sweep.body as { checked: number }).checked).toBe(0);
  });

  it('collects the questions the corpus could not answer, and does not invent a label for them', async () => {
    const conversationId = await newConversation(ctx.app, user.accessToken);
    const asked = await askSse(ctx.app, user.accessToken, conversationId, 'Which standard covers cryogenic impact testing of titanium forgings?');
    expect(asked.evidenceTier).toBe('NONE');

    const gaps = await auth(manager, 'get', `${BASE}/admin/knowledge/gaps`).expect(200);
    const body = gaps.body as {
      items: Array<{ intent: string; count: number; distinctQuestions: number; examples: Array<{ queryText: string; language: string }>; topic: string | null }>;
      total: number;
      note: string;
    };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]!.examples[0]!.queryText).toMatch(/cryogenic/i);
    expect(body.items[0]!.count).toBe(1);
    // R10: the label is derived from the recorded question, and the response says the
    // count is of stored questions rather than of "users who asked".
    expect(body.note).toMatch(/stored|recorded/i);
    // The question text is what was left after PII redaction.
    expect(body.items[0]!.examples[0]!.queryText).not.toMatch(/mobile|email/);
  });

  it('records feedback once per user per message, and keeps other users out', async () => {
    const conversationId = await newConversation(ctx.app, user.accessToken);
    await askSse(ctx.app, user.accessToken, conversationId, 'Which standard covers stainless steel plate?');
    const messages = await request(ctx.app).get(`${BASE}/conversations/${conversationId}/messages`).set('Authorization', `Bearer ${user.accessToken}`).expect(200);
    const assistant = (messages.body as { items: Array<{ id: string; role: string }> }).items.find((m) => m.role === 'assistant')!;

    const first = await auth(user, 'post', `${BASE}/conversations/${conversationId}/messages/${assistant.id}/feedback`)
      .send({ helpful: false, issueType: 'WRONG_ANSWER', comment: 'The clause number is wrong.' })
      .expect(201);
    expect((first.body as { note: string }).note).toMatch(/does not change this answer/i);

    const second = await auth(user, 'post', `${BASE}/conversations/${conversationId}/messages/${assistant.id}/feedback`)
      .send({ helpful: true, rating: 4 })
      .expect(200);
    expect((second.body as { helpful: boolean }).helpful).toBe(true);
    expect(ctx.store.feedback.rows.size).toBe(1);

    // Another user cannot attach feedback to somebody else's message: not theirs is a 404 (R9).
    const stranger = await sessionIn(ctx.app, ctx.store, 'Stranger');
    await auth(stranger, 'post', `${BASE}/conversations/${conversationId}/messages/${assistant.id}/feedback`)
      .send({ helpful: false })
      .expect(404);
    // And a message id from a *different* conversation of the same user is also a 404.
    const other = await newConversation(ctx.app, user.accessToken);
    await auth(user, 'post', `${BASE}/conversations/${other}/messages/${assistant.id}/feedback`).send({ helpful: false }).expect(404);

    const admin = await sessionIn(ctx.app, ctx.store, 'Boss', ['USER', 'CONTENT_MANAGER']);
    const list = await auth(admin, 'get', `${BASE}/admin/feedback`).expect(200);
    const listed = list.body as { total: number; items: Array<{ issueType: string | null }>; open: number };
    expect(listed.total).toBe(1);
    expect(listed.open).toBe(1);
    await auth(user, 'get', `${BASE}/admin/feedback`).expect(403);
  });

  it('throttles a burst of submissions instead of letting one account fill the queue', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const res = await auth(manager, 'post', `${BASE}/admin/ingestion/text`)
        .send({ content: `${TEXT}\n\nVariant ${i}.`, title: `Burst ${i}`, docType: 'STANDARD', language: 'en', publisher: 'BIS' });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 202).length).toBeGreaterThanOrEqual(1);
    expect(statuses).toContain(429);
    // A rate limit must be distinguishable from an outage, and must say when to return.
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(1);
    const refused = await auth(manager, 'post', `${BASE}/admin/ingestion/text`)
      .send({ content: TEXT, title: 'Too many', docType: 'STANDARD', language: 'en', publisher: 'BIS' });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    const throttled = [...ctx.store.auditLogs.rows.values()].filter((row) => row.action === AUDIT_ACTIONS.KNOWLEDGE_INGEST_THROTTLED);
    expect(throttled.length).toBeGreaterThan(0);
    expect(throttled[0]!.actorUserId).toBe(manager.userId);
  });
});

describe('the answer cache through the real request path', () => {
  let fake: Awaited<ReturnType<typeof startFakeProvider>> | null = null;

  afterEach(async () => {
    await fake?.close();
    fake = null;
    resetConfig();
    setConfigForTests(undefined);
    resetProviders();
  });

  async function approvedCorpus() {
    const res = await auth(manager, 'post', `${BASE}/admin/ingestion/text`)
      .send({ content: TEXT, title: 'IS 10500:2012', docType: 'STANDARD', language: 'en', standardNo: 'IS 10500:2012', publisher: 'BIS' })
      .expect(202);
    const job = (await waitForJob(manager, (res.body as { job: { id: string } }).job.id)) as { documentVersionId: string; documentId: string };
    await auth(manager, 'post', `${BASE}/admin/knowledge/documents/${job.documentId}/versions/${job.documentVersionId}/approve`).send({}).expect(200);
  }

  it('serves the second identical question from the cache and logs the hit', async () => {
    await approvedCorpus();
    fake = await startFakeProvider();
    const cited = {
      json: {
        choices: [
          {
            message: {
              content:
                'From sources: for grade 304 the carbon content shall not exceed 0.08 percent by mass [S1].\nExplanation: this is the chemical composition requirement.',
              finish_reason: 'stop',
            },
          },
        ],
        model: 'vendor-large',
        usage: { prompt_tokens: 500, completion_tokens: 60 },
      },
    };
    fake.replies.push(cited, cited, cited, cited, cited);
    useProviderConfig({
      LLM_PROVIDER: 'openai-compatible',
      LLM_BASE_URL: fake.baseUrl,
      LLM_API_KEY: 'sk-test-0123456789abcdef',
      ANSWER_CACHE_ENABLED: 'true',
    });

    const firstConversation = await newConversation(ctx.app, user.accessToken);
    const first = await askSse(ctx.app, user.accessToken, firstConversation, 'What is the carbon limit in IS 10500?');
    expect(first.error).toBeNull();
    // At least PARTIAL: one approved chunk was usable evidence. STRONG needs two, and
    // this fixture is a single-paragraph document, so the test pins the honest band
    // rather than inflating the corpus to reach a nicer label.
    expect(['STRONG', 'PARTIAL']).toContain(first.evidenceTier);
    expect(first.usage!.cacheHit).toBe(false);

    const completionsBefore = fake.calls.length;
    expect(completionsBefore).toBe(1);

    // A different conversation, the same question: the cache is not conversation-scoped,
    // it is knowledge-base-and-query scoped.
    const secondConversation = await newConversation(ctx.app, user.accessToken);
    const second = await askSse(ctx.app, user.accessToken, secondConversation, 'What is the carbon limit in IS 10500?');
    expect(second.usage!.cacheHit).toBe(true);
    expect(second.text).toContain('0.08 percent');
    expect(fake.calls).toHaveLength(completionsBefore);
    // The cached answer still carries its sources and tier, so the evidence rail renders
    // the same thing it would for a generated answer (R3 is not a cache exception).
    expect(second.sources.length).toBeGreaterThan(0);
    expect(second.evidenceTier).toBe(first.evidenceTier);
    expect(second.usage!.cacheMatch).toBe('exact');
    expect(answerCacheEntryCount()).toBe(1);
  });

  it('does not cache a personalised or PII-bearing turn, even when the answer was good', async () => {
    await approvedCorpus();
    fake = await startFakeProvider();
    const cited = {
      json: {
        choices: [{ message: { content: 'From sources: the carbon limit is 0.08 percent by mass [S1].' }, finish_reason: 'stop' }],
        model: 'vendor-large',
        usage: { prompt_tokens: 400, completion_tokens: 40 },
      },
    };
    fake.replies.push(cited, cited, cited, cited, cited, cited);
    useProviderConfig({ LLM_PROVIDER: 'openai-compatible', LLM_BASE_URL: fake.baseUrl, LLM_API_KEY: 'sk-test-0123456789abcdef' });

    const conversation = await newConversation(ctx.app, user.accessToken);
    const asked = await askSse(ctx.app, user.accessToken, conversation, 'What is the carbon limit in IS 10500? My GST is 27ABCDE1234F1Z5 and my phone is 9876543210.');
    expect(['STRONG', 'PARTIAL']).toContain(asked.evidenceTier);
    expect(asked.usage!.cacheHit).toBe(false);
    const second = await askSse(ctx.app, user.accessToken, conversation, 'What is the carbon limit in IS 10500? My GST is 27ABCDE1234F1Z5 and my phone is 9876543210.');
    // Two completions, not one: the turn was never stored.
    expect(second.usage!.cacheHit).toBe(false);
    expect(fake.calls.length).toBeGreaterThanOrEqual(2);
    // And the second message has history, which is its own reason to refuse the cache.
    expect(answerCacheEntryCount()).toBe(0);
  });

  it('leaves an answer that had no evidence uncached and records it as a gap', async () => {
    useProviderConfig({ LLM_PROVIDER: 'mock', EMBEDDING_PROVIDER: 'mock' });
    const conversation = await newConversation(ctx.app, user.accessToken);
    const asked = await askSse(ctx.app, user.accessToken, conversation, 'Which standard covers cryogenic impact testing of titanium forgings?');
    expect(asked.evidenceTier).toBe('NONE');
    expect((asked.usage as { cacheHit: boolean }).cacheHit).toBe(false);
    expect(asked.text).toContain('could not find sufficient information');
    expect(answerCacheEntryCount()).toBe(0);
    const gaps = await auth(manager, 'get', `${BASE}/admin/knowledge/gaps`).expect(200);
    expect((gaps.body as { total: number }).total).toBe(1);
  });
});
