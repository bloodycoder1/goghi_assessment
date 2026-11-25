import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { COLLECTIONS, closeDb, ensureIndexes, getDb } from '../src/db.js';
import { closeRedis, getRedis } from '../src/redis.js';
import { createSession } from '../src/services/auth.js';
import {
  handlePayboxWebhook,
  subscribeWorkspace,
  updateWorkspaceSeats,
} from '../src/services/billing.js';
import type { BillingWorkspaceDoc } from '../src/types.js';

const app = createApp();

function signPayboxPayload(raw: Buffer, timestampSec = Math.floor(Date.now() / 1000)): string {
  const sig = crypto
    .createHmac('sha256', config.paybox.webhookSecret)
    .update(`${timestampSec}.${raw.toString('utf8')}`)
    .digest('hex');
  return `t=${timestampSec},v1=${sig}`;
}

describe('Module 10: Paybox Per-Seat Billing & Enforcement', () => {
  let adminSession = '';
  let agentSession = '';

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

    adminSession = await createSession({
      sub: 'u_asha',
      email: 'asha@acme.test',
      name: 'Asha Rao',
      workspaces: [{ id: 'ws_acme', role: 'admin' }],
    });
    agentSession = await createSession({
      sub: 'u_ben',
      email: 'ben@acme.test',
      name: 'Ben Ortiz',
      workspaces: [{ id: 'ws_acme', role: 'agent' }],
    });
  });

  afterAll(async () => {
    await Promise.allSettled([closeDb(), closeRedis()]);
  });

  it('restricts /api/billing* to workspace admins (403 for agents)', async () => {
    await request(app)
      .get('/api/billing?workspace=ws_acme')
      .set('Cookie', `sb_session=${agentSession}`)
      .expect(403);

    const res = await request(app)
      .get('/api/billing?workspace=ws_acme')
      .set('Cookie', `sb_session=${adminSession}`)
      .expect(200);

    expect(res.body.status).toBe('none');
    expect(res.body.can_send).toBe(true);
  });

  it('handles concurrent subscribe calls, seat updates, and Paybox 402 failures', async () => {
    let customerCreates = 0;
    let currentStatus = 'active';
    let currentQty = 3;

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/v1/customers')) {
        customerCreates++;
        return new Response(JSON.stringify({ id: 'cus_acme_1' }), { status: 200 });
      }
      if (u.includes('/payment_method')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (u.endsWith('/v1/subscriptions')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { quantity?: number };
        currentQty = body.quantity ?? 3;
        return new Response(
          JSON.stringify({
            id: 'sub_acme_1',
            customer: 'cus_acme_1',
            status: currentStatus,
            quantity: currentQty,
            metadata: { workspace: 'ws_acme' },
          }),
          { status: 200 }
        );
      }
      if (u.endsWith('/v1/subscriptions/sub_acme_1')) {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}')) as { quantity?: number };
          if (body.quantity === 99) {
            return new Response(JSON.stringify({ error: 'card_declined' }), { status: 402 });
          }
          currentQty = body.quantity ?? currentQty;
        }
        return new Response(
          JSON.stringify({
            id: 'sub_acme_1',
            customer: 'cus_acme_1',
            status: currentStatus,
            quantity: currentQty,
            metadata: { workspace: 'ws_acme' },
          }),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    });

    // 3 concurrent subscribes serialize via Redis lock and create only 1 customer
    const results = await Promise.all([
      subscribeWorkspace({ workspace: 'ws_acme', seats: 3, token: 'tok_1' }, mockFetch as typeof fetch),
      subscribeWorkspace({ workspace: 'ws_acme', seats: 3, token: 'tok_1' }, mockFetch as typeof fetch),
      subscribeWorkspace({ workspace: 'ws_acme', seats: 3, token: 'tok_1' }, mockFetch as typeof fetch),
    ]);

    expect(customerCreates).toBe(1);
    expect(results.every((r) => r.statusCode === 200 && r.billing.status === 'active')).toBe(true);

    // Successful seat change
    const updOk = await updateWorkspaceSeats(
      { workspace: 'ws_acme', seats: 5 },
      mockFetch as typeof fetch
    );
    expect(updOk.statusCode).toBe(200);
    expect(updOk.billing.seats).toBe(5);

    // Failed seat increase returns 402 and preserves existing seat count (5)
    const updFail = await updateWorkspaceSeats(
      { workspace: 'ws_acme', seats: 99 },
      mockFetch as typeof fetch
    );
    expect(updFail.statusCode).toBe(402);
    expect(updFail.billing.seats).toBe(5);
  });

  it('rejects forged Paybox webhooks, syncs live state, and blocks canceled sending with 402', async () => {
    const db = await getDb();
    await db.collection<BillingWorkspaceDoc>(COLLECTIONS.billingWorkspaces).insertOne({
      workspace: 'ws_acme',
      customerId: 'cus_acme_1',
      subscriptionId: 'sub_acme_1',
      status: 'active',
      seats: 2,
      updatedAt: new Date(),
    });

    // Forged webhook via HTTP route returns 401
    await request(app)
      .post('/webhooks/paybox')
      .set('x-paybox-signature', 't=123,v1=deadbeef')
      .send({ id: 'evt_forged', type: 'invoice.paid', data: { object: {} } })
      .expect(401);

    // Signed webhook fetches live subscription status ('canceled') from Paybox
    const raw = Buffer.from(
      JSON.stringify({
        id: 'evt_cancel_1',
        type: 'customer.subscription.deleted',
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: 'sub_acme_1', status: 'canceled' } },
      }),
      'utf8'
    );
    const sig = signPayboxPayload(raw);

    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 'sub_acme_1',
          customer: 'cus_acme_1',
          status: 'canceled',
          quantity: 2,
          metadata: { workspace: 'ws_acme' },
        }),
        { status: 200 }
      )
    );

    const whRes = await handlePayboxWebhook(raw, sig, mockFetch as typeof fetch);
    expect(whRes.status).toBe(200);

    // Snapshot reflects can_send: false
    const snapRes = await request(app)
      .get('/__grader/snapshot')
      .set('x-grader-token', config.graderToken)
      .expect(200);
    expect(snapRes.body.workspaces.ws_acme.billing).toEqual({
      status: 'canceled',
      seats: 2,
      can_send: false,
    });

    // Both /__grader/reply and /api/conversations/:contact/reply return 402
    await request(app)
      .post('/__grader/reply')
      .set('x-grader-token', config.graderToken)
      .send({
        workspace: 'ws_acme',
        contact: '+14155550101',
        text: 'Blocked reply',
        client_ref: 'ref_blocked_402',
      })
      .expect(402);

    await request(app)
      .post('/api/conversations/+14155550101/reply?workspace=ws_acme')
      .set('Cookie', `sb_session=${adminSession}`)
      .send({ text: 'Blocked UI reply' })
      .expect(402);
  });
});
