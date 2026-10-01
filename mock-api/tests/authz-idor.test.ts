import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { BASE, newSession, newConversation } from './helpers';
import { auditLogs } from '../src/db/store';

/**
 * P1 exit gate: "authz + IDOR tests pass".
 *
 * R9 (ownership) and §4 (server-side role enforcement) are the two properties
 * under test. Frontend guards are cosmetic; nothing here relies on them.
 */

const ADMIN_ENDPOINTS = [
  { path: '/admin/ingestion/jobs', minimum: 'CONTENT_MANAGER' as const },
  { path: '/admin/knowledge/stats', minimum: 'CONTENT_MANAGER' as const },
  { path: '/admin/audit-logs', minimum: 'ADMIN' as const },
];

describe('authorisation: role gates on every admin endpoint', () => {
  it('rejects anonymous callers with 401', async () => {
    const session = await newSession();
    for (const ep of ADMIN_ENDPOINTS) {
      const res = await request(session.app).get(`${BASE}${ep.path}`).expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('rejects a plain USER with 403 on every admin endpoint', async () => {
    const session = await newSession();
    for (const ep of ADMIN_ENDPOINTS) {
      const res = await request(session.app)
        .get(`${BASE}${ep.path}`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('lets CONTENT_MANAGER into CONTENT_MANAGER routes but not ADMIN-only ones', async () => {
    const manager = await newSession({ roles: ['CONTENT_MANAGER'] });
    await request(manager.app)
      .get(`${BASE}/admin/ingestion/jobs`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    await request(manager.app)
      .get(`${BASE}/admin/knowledge/stats`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    const denied = await request(manager.app)
      .get(`${BASE}/admin/audit-logs`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
  });

  it('lets ADMIN into every admin route (ADMIN ⊃ CONTENT_MANAGER)', async () => {
    const admin = await newSession({ roles: ['ADMIN'] });
    for (const ep of ADMIN_ENDPOINTS) {
      await request(admin.app)
        .get(`${BASE}${ep.path}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
    }
  });

  it('audits every denied admin access (§8)', async () => {
    const user = await newSession();
    await request(user.app)
      .get(`${BASE}/admin/audit-logs`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(403);

    const entries = auditLogs.list(user.store, 50);
    const denial = entries.find((a) => a.action === 'admin.access.denied');
    expect(denial).toBeDefined();
    expect(denial!.outcome).toBe('DENIED');
    expect(denial!.actorUserId).toBe(user.userId);
    expect(denial!.metadata).toMatchObject({ requiredRole: 'ADMIN' });
  });

  it('cannot reach admin routes by case or trailing-slash tricks', async () => {
    const user = await newSession();
    for (const variant of ['/ADMIN/audit-logs', '/admin/audit-logs/', '/admin//audit-logs']) {
      const res = await request(user.app)
        .get(`${BASE}${variant}`)
        .set('Authorization', `Bearer ${user.accessToken}`);
      // Either the route matches and is denied, or it does not exist. Never 200.
      expect([401, 403, 404]).toContain(res.status);
      expect(res.status).not.toBe(200);
    }
  });
});

describe('R9: user data isolation (IDOR)', () => {
  async function twoUsers() {
    const a = await newSession({ fullName: 'Owner Person' });
    // A second, independent app+store would trivially isolate, so both users are
    // created in the SAME store to make the check meaningful.
    const email = `intruder.${Date.now()}@example.test`;
    const registered = await request(a.app)
      .post(`${BASE}/auth/register`)
      .send({ email, password: 'Intruder-Horse-9', fullName: 'Intruder Person' })
      .expect(201);
    return {
      app: a.app,
      store: a.store,
      owner: a,
      intruderToken: registered.body.accessToken as string,
      intruderId: registered.body.user.id as string,
    };
  }

  it('hides another user\'s conversation behind a 404, not a 403', async () => {
    const { app, owner, intruderToken } = await twoUsers();
    const conversationId = await newConversation(app, owner.accessToken, 'Owner private chat');

    const res = await request(app)
      .get(`${BASE}/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    // 403 would confirm the resource exists; the message must not either.
    expect(res.body.error.message).toBe('Conversation not found.');
  });

  it('blocks another user renaming, deleting and reading messages', async () => {
    const { app, owner, intruderToken } = await twoUsers();
    const conversationId = await newConversation(app, owner.accessToken, 'Owner chat');

    await request(app)
      .patch(`${BASE}/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .send({ title: 'hijacked' })
      .expect(404);

    await request(app)
      .get(`${BASE}/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .expect(404);

    await request(app)
      .delete(`${BASE}/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .expect(404);

    // The owner's data is untouched.
    const stillThere = await request(app)
      .get(`${BASE}/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(stillThere.body.title).toBe('Owner chat');
  });

  it('blocks another user from posting a message into someone else\'s conversation', async () => {
    const { app, owner, intruderToken } = await twoUsers();
    const conversationId = await newConversation(app, owner.accessToken);

    const res = await request(app)
      .post(`${BASE}/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .send({ content: 'Which standard applies to drinking water?' });
    expect(res.status).toBe(404);
  });

  it('lists only the caller\'s own conversations', async () => {
    const { app, owner, intruderToken } = await twoUsers();
    await newConversation(app, owner.accessToken, 'Owner chat one');
    await newConversation(app, owner.accessToken, 'Owner chat two');
    await newConversation(app, intruderToken, 'Intruder chat');

    const ownerList = await request(app)
      .get(`${BASE}/conversations`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(ownerList.body.total).toBe(2);
    expect(ownerList.body.items.map((c: { title: string }) => c.title).sort()).toEqual([
      'Owner chat one',
      'Owner chat two',
    ]);

    const intruderList = await request(app)
      .get(`${BASE}/conversations`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .expect(200);
    expect(intruderList.body.total).toBe(1);
    expect(intruderList.body.items[0].title).toBe('Intruder chat');
  });

  it('does not leak another user through /users/me', async () => {
    const { app, owner, intruderToken, intruderId } = await twoUsers();
    const me = await request(app).get(`${BASE}/users/me`).set('Authorization', `Bearer ${intruderToken}`).expect(200);
    expect(me.body.id).toBe(intruderId);
    expect(me.body.id).not.toBe(owner.userId);
    expect(me.body.email).not.toBe(owner.email);
  });

  it('rejects a guessed UUID for a conversation that never existed', async () => {
    const { app, owner } = await twoUsers();
    await request(app)
      .get(`${BASE}/conversations/00000000-0000-4000-8000-000000000000`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);
  });
});

describe('profile updates cannot escalate privilege', () => {
  it('rejects unknown keys including roles/admin/emailVerified', async () => {
    const session = await newSession();
    for (const payload of [
      { roles: ['ADMIN'] },
      { role: 'ADMIN' },
      { emailVerified: true },
      { email: 'someone.else@example.test' },
      { id: 'another-user-id' },
    ]) {
      const res = await request(session.app)
        .patch(`${BASE}/users/me`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send(payload)
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
    const me = await request(session.app)
      .get(`${BASE}/users/me`)
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);
    expect(me.body.roles).toEqual(['USER']);
    expect(me.body.emailVerified).toBe(false);
  });

  it('accepts legitimate profile fields', async () => {
    const session = await newSession();
    const res = await request(session.app)
      .patch(`${BASE}/users/me`)
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ fullName: 'Renamed Person', persona: 'JEWELLER_RETAILER', language: 'hi' })
      .expect(200);
    expect(res.body.fullName).toBe('Renamed Person');
    expect(res.body.persona).toBe('JEWELLER_RETAILER');
    expect(res.body.language).toBe('hi');
  });

  it('rejects an unknown persona value', async () => {
    const session = await newSession();
    await request(session.app)
      .patch(`${BASE}/users/me`)
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ persona: 'SUPERUSER' })
      .expect(400);
  });
});
