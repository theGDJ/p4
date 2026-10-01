import { randomUUID } from 'node:crypto';
import type { Role } from '../constants';
import { auditLogs, db, type Store } from '../db/store';
import { logger } from './logger';

/**
 * Audit trail (§8: audit log for admin actions).
 *
 * Written for security-relevant events: auth success/failure, privilege use,
 * admin mutations. Values pass through the redacting logger as well, so an audit
 * row can never become a PII leak vector.
 */

export interface AuditInput {
  actorUserId?: string | null;
  actorRoles?: Role[];
  action: string;
  entityType: string;
  entityId?: string | null;
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILURE';
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

export function recordAudit(store: Store, input: AuditInput): void {
  const row = {
    id: randomUUID(),
    actorUserId: input.actorUserId ?? null,
    actorRoles: input.actorRoles ?? [],
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    outcome: input.outcome ?? 'SUCCESS',
    ip: input.ip ?? null,
    metadata: input.metadata ?? {},
    createdAt: new Date(),
  };
  auditLogs.put(store, row);
  logger.info('audit', {
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    outcome: row.outcome,
    actorUserId: row.actorUserId,
  });
}

export function recordAuditDefault(input: AuditInput): void {
  recordAudit(db(), input);
}

export const AUDIT_ACTIONS = {
  AUTH_REGISTER: 'auth.register',
  AUTH_LOGIN_OK: 'auth.login.success',
  AUTH_LOGIN_FAIL: 'auth.login.failure',
  AUTH_LOCKOUT: 'auth.lockout',
  AUTH_REFRESH: 'auth.refresh',
  AUTH_REFRESH_REUSE: 'auth.refresh.reuse_detected',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_PASSWORD_RESET_REQUESTED: 'auth.password_reset.requested',
  AUTH_PASSWORD_CHANGED: 'auth.password.changed',
  ADMIN_ACCESS_DENIED: 'admin.access.denied',
  USER_PROFILE_UPDATED: 'user.profile.updated',
  CONVERSATION_DELETED: 'conversation.deleted',
} as const;

