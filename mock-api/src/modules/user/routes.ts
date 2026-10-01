import { Router } from 'express';
import type { Store } from '../../db/store';
import { recordAudit, AUDIT_ACTIONS } from '../../lib/audit';
import { clientIp } from '../../lib/rateLimit';
import { patchMeSchema, validateBody } from '../../lib/validate';
import { authenticate, type AuthenticatedRequest } from '../../security/middleware';
import { publicUser, updateProfile } from '../auth/service';
import { conversations, ingestionJobs, knowledgeDocuments } from '../../db/store';

/**
 * Current-user profile (feature #12 groundwork).
 *
 * `PATCH /users/me` accepts only the fields in `patchMeSchema`. Role, email and
 * emailVerified are not writable through this endpoint, so a client cannot
 * escalate privileges by posting them (§4).
 */
export function userRouter(store: Store): Router {
  const router = Router();
  router.use(authenticate(store));

  router.get('/me', (req, res) => {
    const r = req as AuthenticatedRequest;
    const user = r.user!;
    res.json({
      ...publicUser(user),
      // Non-sensitive account state the UI needs to render honestly.
      locked: Boolean(user.lockedUntil && user.lockedUntil.getTime() > Date.now()),
      conversationCount: conversations.countForUser(store, user.id),
    });
  });

  router.patch('/me', validateBody(patchMeSchema), (req, res) => {
    const r = req as AuthenticatedRequest;
    const updated = updateProfile(store, r.user!.id, req.body);
    recordAudit(store, {
      actorUserId: updated.id,
      actorRoles: updated.roles,
      action: AUDIT_ACTIONS.USER_PROFILE_UPDATED,
      entityType: 'user',
      entityId: updated.id,
      ip: clientIp(req),
      metadata: { fields: Object.keys(req.body) },
    });
    res.json(publicUser(updated));
  });

  return router;
}

/** Read-only counters used by the dashboard and admin shell. */
export function statsFor(store: Store) {
  return {
    users: store.users.rows.size,
    conversations: store.conversations.rows.size,
    messages: store.messages.rows.size,
    approvedDocuments: knowledgeDocuments.approved(store).length,
    approvedChunks: store.knowledgeChunks.rows.size,
    ingestionJobs: ingestionJobs.list(store, 1000).length,
    kbVersion: store.kbVersion,
  };
}
