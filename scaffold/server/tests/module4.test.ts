import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { COLLECTIONS, closeDb, ensureIndexes, getDb } from '../src/db.js';
import { closeRedis, getRedis } from '../src/redis.js';
import {
  getConversationMessages,
  listConversations,
  setConversationStatus,
} from '../src/services/conversations.js';

const app = createApp();

describe('Module 4: Conversations, Atomic Claiming & /__grader/claim', () => {
  beforeAll(async () => {
    await getDb();
    await ensureIndexes();
    await getRedis().ping();
  });

  beforeEach(async () => {
    await request(app)
      .post('/__grader/reset')
      .set('x-grader-token', config.graderToken)
      .expect(200);
  });

  afterAll(async () => {
    await Promise.allSettled([closeDb(), closeRedis()]);
  });

  it('validates /__grader/claim auth, fields, and unknown workspace', async () => {
    await request(app)
      .post('/__grader/claim')
      .send({ workspace: 'ws_acme', contact: '+14155550101', agent: 'u_ben' })
      .expect(401);

    await request(app)
      .post('/__grader/claim')
      .set('x-grader-token', config.graderToken)
      .send({ workspace: 'ws_acme', contact: '+14155550101' })
      .expect(400);

    await request(app)
      .post('/__grader/claim')
      .set('x-grader-token', config.graderToken)
      .send({ workspace: 'ws_nope', contact: '+14155550101', agent: 'u_ben' })
      .expect(404);
  });

  it('creates conversation if contact has not written, allows holder re-claim (200), and blocks others (409)', async () => {
    const res1 = await request(app)
      .post('/__grader/claim')
      .set('x-grader-token', config.graderToken)
      .send({ workspace: 'ws_acme', contact: '+14155550101', agent: 'agent_opaque_1' });
    expect(res1.status).toBe(200);

    // Same holder claiming again -> 200
    const res2 = await request(app)
      .post('/__grader/claim')
      .set('x-grader-token', config.graderToken)
      .send({ workspace: 'ws_acme', contact: '+14155550101', agent: 'agent_opaque_1' });
    expect(res2.status).toBe(200);

    // Different agent -> 409
    const res3 = await request(app)
      .post('/__grader/claim')
      .set('x-grader-token', config.graderToken)
      .send({ workspace: 'ws_acme', contact: '+14155550101', agent: 'agent_opaque_2' });
    expect(res3.status).toBe(409);

    const snap = await request(app)
      .get('/__grader/snapshot')
      .set('x-grader-token', config.graderToken)
      .expect(200);
    expect(snap.body.workspaces.ws_acme.contacts['+14155550101']).toEqual({
      inbound: [],
      assignee: 'agent_opaque_1',
    });
  });

  it('allows exactly 1 winner out of 6 concurrent claims on a brand-new contact', async () => {
    const agents = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
    const responses = await Promise.all(
      agents.map((agent) =>
        request(app)
          .post('/__grader/claim')
          .set('x-grader-token', config.graderToken)
          .send({ workspace: 'ws_acme', contact: '+14155550199', agent })
      )
    );

    const ok = responses.filter((r) => r.status === 200);
    const conflicts = responses.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(5);

    const winner = ok[0].body.assignee;
    const snap = await request(app)
      .get('/__grader/snapshot')
      .set('x-grader-token', config.graderToken)
      .expect(200);
    expect(snap.body.workspaces.ws_acme.contacts['+14155550199'].assignee).toBe(winner);
  });

  it('lists conversations newest-first with pagination and supports close/reopen', async () => {
    const db = await getDb();
    const t1 = new Date('2026-11-18T10:00:00Z');
    const t2 = new Date('2026-11-18T10:05:00Z');
    const t3 = new Date('2026-11-18T10:10:00Z');

    await db.collection(COLLECTIONS.conversations).insertMany([
      { workspace: 'ws_acme', contact: '+1001', assignee: null, status: 'open', lastActivityAt: t1, createdAt: t1, updatedAt: t1 },
      { workspace: 'ws_acme', contact: '+1002', assignee: null, status: 'open', lastActivityAt: t3, createdAt: t3, updatedAt: t3 },
      { workspace: 'ws_acme', contact: '+1003', assignee: null, status: 'open', lastActivityAt: t2, createdAt: t2, updatedAt: t2 },
    ]);

    const page1 = await listConversations({ workspace: 'ws_acme', limit: 2, offset: 0 });
    expect(page1.total).toBe(3);
    expect(page1.conversations.map((c) => c.contact)).toEqual(['+1002', '+1003']);

    const page2 = await listConversations({ workspace: 'ws_acme', limit: 2, offset: 2 });
    expect(page2.conversations.map((c) => c.contact)).toEqual(['+1001']);

    const closed = await setConversationStatus('ws_acme', '+1002', 'closed');
    expect(closed?.status).toBe('closed');
    const reopened = await setConversationStatus('ws_acme', '+1002', 'open');
    expect(reopened?.status).toBe('open');

    const msgs = await getConversationMessages('ws_acme', '+1002');
    expect(msgs).toEqual([]);
  });
});
