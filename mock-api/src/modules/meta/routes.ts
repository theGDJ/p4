import { Router } from 'express';
import { config } from '../../config';
import type { Store } from '../../db/store';
import { knowledgeChunks, knowledgeDocuments, ingestionJobs, auditLogs } from '../../db/store';
import { hashingStatus } from '../../lib/password';
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

export function healthRouter(store: Store): Router {
  const router = Router();
  const c = config();
  const llm = resolveLlmProvider();
  const embeddings = resolveEmbeddingProvider();

  router.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'UP', uptimeSeconds: Math.round(process.uptime()) });
  });

  router.get('/health/ready', (_req, res) => {
    const components: Record<string, { status: 'UP' | 'DOWN'; detail?: string }> = {
      // The mock API has no Postgres/Redis; the store is in-process. This reports
      // the real dependency situation instead of pretending a DB is attached.
      store: { status: 'UP', detail: 'in-memory (mock stack; Spring Boot uses PostgreSQL + pgvector)' },
      llmProvider: llm.isMock
        ? { status: 'UP', detail: 'mock provider — no grounded answers can be generated' }
        : { status: 'DOWN', detail: 'a real provider is selected but not implemented by the mock API' },
      embeddingProvider: { status: 'UP', detail: `${embeddings.name} (${embeddings.dimensions}d)` },
    };

    const hashing = hashingStatus();
    components.passwordHashing = {
      status: 'UP',
      detail: hashing.argon2LoadError ? `fallback: ${hashing.scheme}` : hashing.scheme,
    };

    const allUp = Object.values(components).every((v) => v.status === 'UP');
    res.status(allUp ? 200 : 503).json({
      status: allUp ? 'UP' : 'DEGRADED',
      stack: 'mock',
      env: c.NODE_ENV,
      components,
      knowledge: {
        approvedDocuments: knowledgeDocuments.approved(store).length,
        approvedChunks: knowledgeChunks.countRetrievable(store),
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
        kbVersion: store.kbVersion,
      },
      security: { passwordScheme: hashingStatus().scheme, csrfEnabled: c.CSRF_ENABLED },
      disclaimer: 'Informational — verify against current official sources',
    });
  });

  return router;
}

/**
 * Admin surface. P1 exposes read-only views; the full knowledge admin
 * (feature #4) lands in P2 and the monitoring suite in P5.
 *
 * Roles are enforced here, server-side, on every route (§4). The frontend hides
 * links cosmetically; that hiding is never the control.
 */
export function adminRouter(store: Store): Router {
  const router = Router();
  const contentManager = [authenticate(store), requireRole(store, 'CONTENT_MANAGER')];
  const adminOnly = [authenticate(store), requireRole(store, 'ADMIN')];

  router.get('/admin/ingestion/jobs', ...contentManager, (_req, res) => {
    const jobs = ingestionJobs.list(store, 200);
    res.json({
      items: jobs.map((j) => ({
        id: j.id,
        documentId: j.documentId,
        sourceKind: j.sourceKind,
        state: j.state,
        stage: j.stage,
        error: j.error,
        attempts: j.attempts,
        chunksProduced: j.chunksProduced,
        requestedBy: j.requestedBy,
        createdAt: j.createdAt.toISOString(),
        updatedAt: j.updatedAt.toISOString(),
      })),
      total: jobs.length,
      // R8: failed jobs are counted and surfaced, never hidden.
      failed: jobs.filter((j) => j.state === 'FAILED').length,
    });
  });

  router.get('/admin/knowledge/stats', ...contentManager, (_req, res) => {
    res.json({
      documents: knowledgeDocuments.approved(store).length,
      chunks: knowledgeChunks.countRetrievable(store),
      kbVersion: store.kbVersion,
      jobs: ingestionJobs.list(store, 1000).length,
      // Coverage is derived from real ingestion state only — never a projected
      // or illustrative figure (R10).
      coverage: {
        derivedFrom: 'ingestion state',
        documentsApproved: knowledgeDocuments.approved(store).length,
        note: 'No coverage percentage is published until a manifest exists (P0).',
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
