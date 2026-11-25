import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { COLLECTIONS, closeDb, ensureIndexes, getDb } from '../src/db.js';
import { closeRedis, getRedis } from '../src/redis.js';
import { OutboxWorker } from '../src/services/outboxWorker.js';
import { acquireWorkspaceSendToken } from '../src/services/rateLimiter.js';
import type { OutboxJobDoc } from '../src/types.js';

const app = createApp();

describe('Module 3: Durable Outbound Queue, Rate Limiter & /__grader/reply', () => {
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

  it('validates /__grader/reply auth, required fields, and unknown workspace', async () => {
    await request(app)
      .post('/__grader/reply')
      .send({ workspace: 'ws_acme', contact: '+14155550101', text: 'hi', client_ref: 'c1' })
      .expect(401);

    await request(app)
      .post('/__grader/reply')
      .set('x-grader-token', config.graderToken)
      .send({ workspace: 'ws_acme', contact: '+14155550101' })
      .expect(400);

    await request(app)
      .post('/__grader/reply')
      .set('x-grader-token', config.graderToken)
      .send({ workspace: 'ws_missing', contact: '+14155550101', text: 'hi', client_ref: 'c1' })
      .expect(404);
  });

  it('deduplicates concurrent /__grader/reply with same client_ref and sends once with Idempotency-Key', async () => {
    const payload = {
      workspace: 'ws_acme',
      contact: '+14155550101',
      text: 'Hello from agent',
      client_ref: 'ref_dup_1',
    };

    const [r1, r2] = await Promise.all([
      request(app)
        .post('/__grader/reply')
        .set('x-grader-token', config.graderToken)
        .send(payload),
      request(app)
        .post('/__grader/reply')
        .set('x-grader-token', config.graderToken)
        .send(payload),
    ]);

    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);

    const db = await getDb();
    expect(await db.collection(COLLECTIONS.messages).countDocuments({ clientRef: 'ref_dup_1' })).toBe(1);
    expect(await db.collection(COLLECTIONS.outboxJobs).countDocuments({ clientRef: 'ref_dup_1' })).toBe(1);

    const calls: Array<{ url: string; idempotencyKey: string | null; auth: string | null }> = [];
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(url),
        idempotencyKey: headers.get('idempotency-key'),
        auth: headers.get('authorization'),
      });
      return new Response(JSON.stringify({ id: 'pm_100', status: 'accepted' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const worker = new OutboxWorker({ fetchImpl: mockFetch as unknown as typeof fetch });
    worker.start();
    await worker.tick();
    await worker.stop();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      url: `${config.pigeon.url}/v1/messages`,
      idempotencyKey: 'ref_dup_1',
      auth: `Bearer ${config.pigeon.apiKeys.ws_acme}`,
    });

    const snap = await request(app)
      .get('/__grader/snapshot')
      .set('x-grader-token', config.graderToken)
      .expect(200);
    expect(snap.body.workspaces.ws_acme.contacts['+14155550101']).toEqual({
      inbound: [],
      assignee: null,
    });
    expect(snap.body.workspaces.ws_acme.outbound).toEqual({ ref_dup_1: 'queued' });
  });

  it('retries on 503 outage and 429 Retry-After without losing the message', async () => {
    await request(app)
      .post('/__grader/reply')
      .set('x-grader-token', config.graderToken)
      .send({
        workspace: 'ws_acme',
        contact: '+14155550102',
        text: 'Retry test',
        client_ref: 'ref_retry_1',
      })
      .expect(202);

    let attempt = 0;
    const mockFetch = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response('Service Unavailable', { status: 503 });
      }
      if (attempt === 2) {
        return new Response('Rate Limited', {
          status: 429,
          headers: { 'Retry-After': '0.3' },
        });
      }
      return new Response(JSON.stringify({ id: 'pm_retry_ok', status: 'accepted' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const worker = new OutboxWorker({ fetchImpl: mockFetch as unknown as typeof fetch });
    const db = await getDb();

    // First attempt -> 503
    const job1 = await db
      .collection<OutboxJobDoc>(COLLECTIONS.outboxJobs)
      .findOne({ clientRef: 'ref_retry_1' });
    await worker.processJob(job1!);
    let after1 = await db
      .collection<OutboxJobDoc>(COLLECTIONS.outboxJobs)
      .findOne({ clientRef: 'ref_retry_1' });
    expect(after1?.status).toBe('pending');

    // Second attempt -> 429
    await worker.processJob(after1!);
    const after2 = await db
      .collection<OutboxJobDoc>(COLLECTIONS.outboxJobs)
      .findOne({ clientRef: 'ref_retry_1' });
    expect(after2?.status).toBe('pending');
    expect(await getRedis().get('ratelimit:blocked_until:ws_acme')).not.toBeNull();

    // Wait for Retry-After window to pass, then third attempt -> 200
    await new Promise((r) => setTimeout(r, 400));
    await worker.processJob(after2!);
    const after3 = await db
      .collection<OutboxJobDoc>(COLLECTIONS.outboxJobs)
      .findOne({ clientRef: 'ref_retry_1' });
    expect(after3?.status).toBe('done');
    expect(attempt).toBe(3);
  });

  it('enforces per-workspace 8-burst token bucket in Redis independently across workspaces', async () => {
    const now = Date.now();
    for (let i = 0; i < 8; i++) {
      const res = await acquireWorkspaceSendToken('ws_acme', now);
      expect(res.allowed).toBe(true);
    }
    const ninth = await acquireWorkspaceSendToken('ws_acme', now);
    expect(ninth.allowed).toBe(false);
    expect(ninth.waitMs).toBeGreaterThan(0);

    // Other workspace still has its full bucket
    const otherWs = await acquireWorkspaceSendToken('ws_globex', now);
    expect(otherWs.allowed).toBe(true);
  });

  it('reclaims expired lease from a crashed worker (kill -9 simulation)', async () => {
    const db = await getDb();
    const past = new Date(Date.now() - 30_000);
    await db.collection<OutboxJobDoc>(COLLECTIONS.outboxJobs).insertOne({
      workspace: 'ws_acme',
      contact: '+14155550103',
      text: 'Orphaned reply',
      clientRef: 'ref_orphan_1',
      status: 'sending',
      attempts: 1,
      nextRunAt: past,
      lockedUntil: past,
      lockedBy: 'dead_worker_999',
      createdAt: past,
      updatedAt: past,
    });

    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'pm_orphan_ok', status: 'accepted' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const worker = new OutboxWorker({ fetchImpl: mockFetch as unknown as typeof fetch });
    worker.start();
    await new Promise((r) => setTimeout(r, 250));
    await worker.stop();

    const doneJob = await db
      .collection<OutboxJobDoc>(COLLECTIONS.outboxJobs)
      .findOne({ clientRef: 'ref_orphan_1' });
    expect(doneJob?.status).toBe('done');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
