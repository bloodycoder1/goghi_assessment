import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { COLLECTIONS, closeDb, ensureIndexes, getDb } from '../src/db.js';
import { closeRedis, getRedis } from '../src/redis.js';

const app = createApp();

function signPigeonBody(rawBody: string, timestampSec = Math.floor(Date.now() / 1000)): string {
  const sig = crypto
    .createHmac('sha256', config.pigeon.webhookSecret)
    .update(`${timestampSec}.${rawBody}`)
    .digest('hex');
  return `t=${timestampSec},v1=${sig}`;
}

describe('Module 1 & Module 2: Foundation, Grader Contract & Pigeon Webhooks', () => {
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

  describe('Module 1: Health & Grader Endpoints', () => {
    it('GET /healthz returns 200 ok', async () => {
      const res = await request(app).get('/healthz').expect(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('rejects /__grader/* without or with invalid x-grader-token', async () => {
      await request(app).get('/__grader/snapshot').expect(401);
      await request(app)
        .get('/__grader/snapshot')
        .set('x-grader-token', 'wrong-token')
        .expect(401);
      await request(app).post('/__grader/reset').expect(401);
    });

    it('POST /__grader/reset clears app data in Mongo and Redis while preserving sessions', async () => {
      const redis = getRedis();
      await redis.set('ws:seq:ws_acme', '42');
      await redis.set('ratelimit:ws_acme', '5');
      await redis.set('session:abc', 'user123');

      await request(app)
        .post('/__grader/reset')
        .set('x-grader-token', config.graderToken)
        .expect(200);

      expect(await redis.get('ws:seq:ws_acme')).toBeNull();
      expect(await redis.get('ratelimit:ws_acme')).toBeNull();
      expect(await redis.get('session:abc')).toBe('user123');
      await redis.del('session:abc');

      const snap = await request(app)
        .get('/__grader/snapshot')
        .set('x-grader-token', config.graderToken)
        .expect(200);
      expect(snap.body).toEqual({ workspaces: {} });
    });
  });

  describe('Module 2: POST /webhooks/pigeon', () => {
    it('returns 401 for missing, malformed, or invalid signatures', async () => {
      const body = JSON.stringify({ id: 'evt_1', type: 'message.inbound', workspace: 'ws_acme' });

      await request(app)
        .post('/webhooks/pigeon')
        .set('content-type', 'application/json')
        .send(body)
        .expect(401);

      await request(app)
        .post('/webhooks/pigeon')
        .set('content-type', 'application/json')
        .set('x-pigeon-signature', 'bad-header')
        .send(body)
        .expect(401);

      await request(app)
        .post('/webhooks/pigeon')
        .set('content-type', 'application/json')
        .set('x-pigeon-signature', `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`)
        .send(body)
        .expect(401);
    });

    it('returns 401 when signature timestamp is more than 5 minutes old, and 200 within 5 minutes', async () => {
      const now = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({
        id: 'evt_old',
        type: 'unknown.event',
        workspace: 'ws_acme',
      });

      await request(app)
        .post('/webhooks/pigeon')
        .set('content-type', 'application/json')
        .set('x-pigeon-signature', signPigeonBody(body, now - 301))
        .send(body)
        .expect(401);

      await request(app)
        .post('/webhooks/pigeon')
        .set('content-type', 'application/json')
        .set('x-pigeon-signature', signPigeonBody(body, now - 240))
        .send(body)
        .expect(200);
    });

    it('returns 400 for valid signature with unparseable JSON body', async () => {
      const raw = '{not valid json';
      await request(app)
        .post('/webhooks/pigeon')
        .set('content-type', 'application/json')
        .set('x-pigeon-signature', signPigeonBody(raw))
        .send(raw)
        .expect(400);
    });

    it('returns 200 and ignores unknown event types and unknown workspaces', async () => {
      const unknownType = JSON.stringify({
        id: 'evt_unk_type',
        type: 'contact.updated',
        workspace: 'ws_acme',
        data: {},
      });
      await request(app)
        .post('/webhooks/pigeon')
        .set('content-type', 'application/json')
        .set('x-pigeon-signature', signPigeonBody(unknownType))
        .send(unknownType)
        .expect(200);

      const unknownWs = JSON.stringify({
        id: 'evt_unk_ws',
        type: 'message.inbound',
        workspace: 'ws_unknown',
        data: { message_id: 'pmsg_1', from: '+14155550101', text: 'hi' },
      });
      await request(app)
        .post('/webhooks/pigeon')
        .set('content-type', 'application/json')
        .set('x-pigeon-signature', signPigeonBody(unknownWs))
        .send(unknownWs)
        .expect(200);

      const snap = await request(app)
        .get('/__grader/snapshot')
        .set('x-grader-token', config.graderToken)
        .expect(200);
      expect(snap.body).toEqual({ workspaces: {} });
    });

    it('stores inbound messages idempotently and orders oldest-first in snapshot', async () => {
      const m2 = JSON.stringify({
        id: 'evt_m2',
        type: 'message.inbound',
        workspace: 'ws_acme',
        occurred_at: '2026-11-18T09:31:00.000Z',
        data: { message_id: 'pmsg_2', from: '+14155550101', text: 'second' },
      });
      const m1 = JSON.stringify({
        id: 'evt_m1',
        type: 'message.inbound',
        workspace: 'ws_acme',
        occurred_at: '2026-11-18T09:30:00.000Z',
        data: { message_id: 'pmsg_1', from: '+14155550101', text: 'first' },
      });
      const m1DupDiffEvent = JSON.stringify({
        id: 'evt_m1_dup',
        type: 'message.inbound',
        workspace: 'ws_acme',
        occurred_at: '2026-11-18T09:30:00.000Z',
        data: { message_id: 'pmsg_1', from: '+14155550101', text: 'first' },
      });

      // Send m2 first, then concurrent duplicates of m1
      await request(app)
        .post('/webhooks/pigeon')
        .set('content-type', 'application/json')
        .set('x-pigeon-signature', signPigeonBody(m2))
        .send(m2)
        .expect(200);

      await Promise.all([
        request(app)
          .post('/webhooks/pigeon')
          .set('content-type', 'application/json')
          .set('x-pigeon-signature', signPigeonBody(m1))
          .send(m1)
          .expect(200),
        request(app)
          .post('/webhooks/pigeon')
          .set('content-type', 'application/json')
          .set('x-pigeon-signature', signPigeonBody(m1))
          .send(m1)
          .expect(200),
        request(app)
          .post('/webhooks/pigeon')
          .set('content-type', 'application/json')
          .set('x-pigeon-signature', signPigeonBody(m1DupDiffEvent))
          .send(m1DupDiffEvent)
          .expect(200),
      ]);

      const snap = await request(app)
        .get('/__grader/snapshot')
        .set('x-grader-token', config.graderToken)
        .expect(200);

      expect(snap.body).toEqual({
        workspaces: {
          ws_acme: {
            contacts: {
              '+14155550101': {
                inbound: ['pmsg_1', 'pmsg_2'],
                assignee: null,
              },
            },
            outbound: {},
            billing: {
              status: 'none',
              seats: 0,
              can_send: true,
            },
          },
        },
      });
    });

    it('handles message.status out-of-order (delivered before sent) and ignores unknown client_ref', async () => {
      const db = await getDb();
      await db.collection(COLLECTIONS.messages).insertOne({
        workspace: 'ws_acme',
        contact: '+14155550101',
        direction: 'outbound',
        text: 'Hello',
        clientRef: 'ref_1',
        status: 'queued',
        occurredAt: new Date(),
        createdAt: new Date(),
      });

      const unknownStatus = JSON.stringify({
        id: 'evt_st_unknown',
        type: 'message.status',
        workspace: 'ws_acme',
        occurred_at: '2026-11-18T09:32:00.000Z',
        data: { message_id: 'pm_999', client_ref: 'never_sent', status: 'delivered' },
      });
      await request(app)
        .post('/webhooks/pigeon')
        .set('content-type', 'application/json')
        .set('x-pigeon-signature', signPigeonBody(unknownStatus))
        .send(unknownStatus)
        .expect(200);

      const deliveredEvt = JSON.stringify({
        id: 'evt_st_delivered',
        type: 'message.status',
        workspace: 'ws_acme',
        occurred_at: '2026-11-18T09:32:05.000Z',
        data: { message_id: 'pm_1', client_ref: 'ref_1', status: 'delivered' },
      });
      await request(app)
        .post('/webhooks/pigeon')
        .set('content-type', 'application/json')
        .set('x-pigeon-signature', signPigeonBody(deliveredEvt))
        .send(deliveredEvt)
        .expect(200);

      // Late 'sent' event must not downgrade 'delivered'
      const sentEvt = JSON.stringify({
        id: 'evt_st_sent',
        type: 'message.status',
        workspace: 'ws_acme',
        occurred_at: '2026-11-18T09:32:01.000Z',
        data: { message_id: 'pm_1', client_ref: 'ref_1', status: 'sent' },
      });
      await request(app)
        .post('/webhooks/pigeon')
        .set('content-type', 'application/json')
        .set('x-pigeon-signature', signPigeonBody(sentEvt))
        .send(sentEvt)
        .expect(200);

      const snap = await request(app)
        .get('/__grader/snapshot')
        .set('x-grader-token', config.graderToken)
        .expect(200);

      expect(snap.body.workspaces.ws_acme.outbound).toEqual({ ref_1: 'delivered' });
    });
  });
});
