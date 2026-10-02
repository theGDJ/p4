import { Router } from 'express';
import { config } from '../../config';
import type { Store } from '../../db/store';
import {
  documentVersions,
  feedback,
  gapQueries,
  ingestionJobs,
  knowledgeChunks,
  knowledgeDocuments,
  auditLogs,
} from '../../db/store';
import { hashingStatus } from '../../lib/password';
import { passwordResetMailFailures } from '../../modules/auth/service';
import { getMailer } from '../../lib/mail';
import { resolveEmbeddingProvider, resolveLlmProvider } from '../../rag/providers';
import { authenticate, requireRole } from '../../security/middleware';

/**
 * Health and bootstrap endpoints.
 *
 * `/health/live` never touches a dependency: it answers "is the process up".
 * `/health/ready` does, and returns 503 with per-component detail when something
 * is down — a dependency failure must be visible, not papered over (R8).
 */

export const APP_VERSION = '0.1.0';

/**
 * `describe()` also carries a base URL and a detail line, which belong in
 * `/health/ready` for an operator — not in a payload any anonymous visitor can read.
 */
function describeForBootstrap(d: { name: string; isMock: boolean; configured: boolean; model: string; dimensions: number | null }) {
  return {
    name: d.name,
    isMock: d.isMock,
    configured: d.configured,
    model: d.model,
    ...(d.dimensions !== null ? { dimensions: d.dimensions } : {}),
  };
}

export function healthRouter(store: Store): Router {
  const router = Router();
  const c = config();
  const llm = resolveLlmProvider();
  const embeddings = resolveEmbeddingProvider();

  router.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'UP', uptimeSeconds: Math.round(process.uptime()) });
  });

  router.get('/health/ready', (_req, res) => {
    const llmDescription = llm.describe();
    const embeddingDescription = embeddings.describe();
    const mailer = getMailer();
    const pendingChunks = knowledgeChunks.countByState(store, 'PENDING_REVIEW');
    const unembedded = knowledgeChunks
      .retrievable(store)
      .filter((chunk) => chunk.embedding === null).length;

    const components: Record<string, { status: 'UP' | 'DOWN' | 'DEGRADED'; detail?: string }> = {
      // The mock API has no Postgres/Redis; the store is in-process. This reports
      // the real dependency situation instead of pretending a DB is attached.
      store: { status: 'UP', detail: 'in-memory (mock stack; Spring Boot uses PostgreSQL + pgvector)' },
      // A mock LLM is *correctly configured*, so it is UP for liveness purposes and
      // reported by name everywhere else; a real-but-unreachable provider is DOWN.
      llmProvider: {
        status: llmDescription.isMock ? 'UP' : llmDescription.configured ? 'UP' : 'DOWN',
        detail: llmDescription.detail,
      },
      embeddingProvider: {
        status: embeddingDescription.configured ? 'UP' : 'DOWN',
        detail: `${embeddingDescription.name} (${embeddingDescription.dimensions}d, model ${embeddingDescription.model})`,
      },
      mail: {
        status: mailer.canDeliver ? 'UP' : 'DEGRADED',
        detail:
          mailer.transport === 'smtp'
            ? `smtp${passwordResetMailFailures() > 0 ? `; ${passwordResetMailFailures()} send failure(s) since boot` : ''}`
            : `transport "${mailer.transport}" — password reset cannot reach a mailbox`,
      },
      ingestion: {
        status: unembedded > 0 ? 'DEGRADED' : 'UP',
        detail:
          `${knowledgeDocuments.count(store)} document(s), ${knowledgeChunks.countRetrievable(store)} approved chunk(s), ` +
          `${pendingChunks} awaiting review${unembedded > 0 ? `, ${unembedded} approved chunk(s) without an embedding` : ''}`,
      },
    };

    const hashing = hashingStatus();
    components.passwordHashing = {
      status: 'UP',
      detail: hashing.argon2LoadError ? `fallback: ${hashing.scheme}` : hashing.scheme,
    };

    // DEGRADED is not DOWN: readiness stays 200 while the app can still answer, but
    // the degraded component and its reason are in the payload (R8).
    const allUp = Object.values(components).every((v) => v.status !== 'DOWN');
    res.status(allUp ? 200 : 503).json({
      status: allUp ? 'UP' : 'DEGRADED',
      stack: 'mock',
      env: c.NODE_ENV,
      components,
      knowledge: {
        approvedDocuments: knowledgeDocuments.approved(store).length,
        approvedChunks: knowledgeChunks.countRetrievable(store),
        pendingChunks,
        kbVersion: store.kbVersion,
      },
    });
  });

  /**
   * Public configuration the shell needs before authentication.
   * `mockProvider` must be rendered as a visible badge whenever true (R8/R10).
   */
  router.get('/meta/bootstrap', (_req, res) => {
    res.json({
      app: {
        name: 'BIS-Saathi',
        version: APP_VERSION,
        env: c.NODE_ENV,
        stack: 'mock',
        mockProvider: llm.isMock,
        providerName: llm.name,
      },
      auth: {
        accessTokenTtlMinutes: c.JWT_ACCESS_TTL_MINUTES,
        personas: ['CONSUMER', 'MSME_MANUFACTURER', 'JEWELLER_RETAILER', 'STUDENT_ENGINEER'],
        languages: ['en', 'hi'],
        passwordMinLength: 10,
        lockoutAfterFailedAttempts: c.LOGIN_MAX_FAILED_ATTEMPTS,
        lockoutMinutes: c.LOGIN_LOCKOUT_MINUTES,
      },
      knowledge: {
        approvedDocuments: knowledgeDocuments.approved(store).length,
        approvedChunks: knowledgeChunks.countRetrievable(store),
        pendingChunks: knowledgeChunks.countByState(store, 'PENDING_REVIEW'),
        kbVersion: store.kbVersion,
      },
      // What the UI needs to say honestly about where an answer came from (R8/R10).
      providers: {
        llm: describeForBootstrap(llm.describe()),
        embeddings: describeForBootstrap(embeddings.describe()),
        costAccounting: c.costAccounting,
      },
      ingestion: {
        enabled: true,
        maxBytes: c.INGEST_MAX_BYTES,
        chunkTokens: { min: c.CHUNK_MIN_TOKENS, max: c.CHUNK_MAX_TOKENS },
        accepts: ['pdf', 'html', 'txt', 'md', 'csv'],
        mailTransport: getMailer().transport,
      },
      security: { passwordScheme: hashingStatus().scheme, csrfEnabled: c.CSRF_ENABLED },
      disclaimer: 'Informational — verify against current official sources',
    });
  });

  return router;
}

/**
 * Admin surface: the read-only counters only. Queueing, review and the freshness
 * sweep live in `modules/ingestion/routes.ts`, which owns the job rows.
 *
 * Roles are enforced here, server-side, on every route (§4). The frontend hides
 * links cosmetically; that hiding is never the control.
 */
export function adminRouter(store: Store): Router {
  const router = Router();
  const contentManager = [authenticate(store), requireRole(store, 'CONTENT_MANAGER')];
  const adminOnly = [authenticate(store), requireRole(store, 'ADMIN')];

  router.get('/admin/knowledge/stats', ...contentManager, (_req, res) => {
    const jobs = ingestionJobs.list(store, 1000);
    res.json({
      documents: knowledgeDocuments.count(store),
      approvedDocuments: knowledgeDocuments.approved(store).length,
      chunks: knowledgeChunks.countRetrievable(store),
      pendingChunks: knowledgeChunks.countByState(store, 'PENDING_REVIEW'),
      rejectedChunks: knowledgeChunks.countByState(store, 'REJECTED'),
      versions: documentVersions.count(store),
      kbVersion: store.kbVersion,
      jobs: jobs.length,
      failedJobs: jobs.filter((j) => j.state === 'FAILED').length,
      gaps: gapQueries.count(store),
      feedbackOpen: feedback.countOpen(store),
      // Coverage is derived from real ingestion state only — never a projected
      // or illustrative figure (R10).
      coverage: {
        derivedFrom: 'ingestion state',
        documentsApproved: knowledgeDocuments.approved(store).length,
        note:
          knowledgeDocuments.count(store) === 0
            ? 'The knowledge base is empty, so every question correctly returns the fallback. No coverage percentage is published until a manifest exists (P0).'
            : 'Counts are of stored rows, not of subject-matter coverage.',
      },
    });
  });

  router.get('/admin/audit-logs', ...adminOnly, (_req, res) => {
    res.json({
      items: auditLogs.list(store, 200).map((a) => ({
        id: a.id,
        actorUserId: a.actorUserId,
        actorRoles: a.actorRoles,
        action: a.action,
        entityType: a.entityType,
        entityId: a.entityId,
        outcome: a.outcome,
        createdAt: a.createdAt.toISOString(),
      })),
    });
  });

  return router;
}
