import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { COLLECTIONS, closeDb, ensureIndexes, getDb } from '../src/db.js';
import { closeRedis, getRedis } from '../src/redis.js';
import { OutboxWorker } from '../src/services/outboxWorker.js';
import type { OutboxJobDoc } from '../src/types.js';

const app = createApp();

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('failed to get free port'));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.status === 200) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server on port ${port} did not become healthy within ${timeoutMs}ms`);
}

describe('Module 7: Multi-Copy Crash & Recovery Hardening (Levels 2 & 3)', () => {
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

  it('reclaims orphaned sending jobs whose lease expired after a worker crash', async () => {
    await request(app)
      .post('/__grader/reply')
      .set('x-grader-token', config.graderToken)
      .send({
        workspace: 'ws_acme',
        contact: '+14155550701',
        text: 'Orphaned message',
        client_ref: 'ref_orphan_1',
      })
      .expect(202);

    const db = await getDb();
    // Simulate a crashed worker holding an expired lease
    await db.collection<OutboxJobDoc>(COLLECTIONS.outboxJobs).updateOne(
      { workspace: 'ws_acme', clientRef: 'ref_orphan_1' },
      {
        $set: {
          status: 'sending',
          lockedBy: 'dead_worker_pid_99999',
          lockedUntil: new Date(Date.now() - 1000),
          attempts: 1,
        },
      }
    );

    const sentKeys: string[] = [];
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      sentKeys.push(headers.get('Idempotency-Key') ?? '');
      return new Response(JSON.stringify({ id: 'pmsg_orphan_ok', status: 'queued' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const survivor = new OutboxWorker({ fetchImpl: mockFetch as typeof fetch, leaseMs: 18_000 });
    survivor.start();
    try {
      await vi.waitFor(() => expect(sentKeys).toEqual(['ref_orphan_1']));
    } finally {
      await survivor.stop();
    }

    const job = await db.collection<OutboxJobDoc>(COLLECTIONS.outboxJobs).findOne({
      workspace: 'ws_acme',
      clientRef: 'ref_orphan_1',
    });
    expect(job?.status).toBe('done');
    expect(job?.lockedBy).toBeNull();
  });

  it('prevents an expired-lease worker from clobbering a newer worker lock', async () => {
    await request(app)
      .post('/__grader/reply')
      .set('x-grader-token', config.graderToken)
      .send({
        workspace: 'ws_acme',
        contact: '+14155550702',
        text: 'Slow worker race',
        client_ref: 'ref_race_1',
      })
      .expect(202);

    const db = await getDb();
    const jobsCol = db.collection<OutboxJobDoc>(COLLECTIONS.outboxJobs);

    // Slow worker fails AFTER another worker already reclaimed the job
    const slowFetch = vi.fn(async () => {
      await jobsCol.updateOne(
        { workspace: 'ws_acme', clientRef: 'ref_race_1' },
        {
          $set: {
            status: 'sending',
            lockedBy: 'newer_worker_2',
            lockedUntil: new Date(Date.now() + 18_000),
          },
        }
      );
      return new Response('outage', { status: 503 });
    });

    const slowWorker = new OutboxWorker({ fetchImpl: slowFetch as typeof fetch });
    const job = await jobsCol.findOne({ workspace: 'ws_acme', clientRef: 'ref_race_1' });
    expect(job).not.toBeNull();

    // Manually set lockedBy to slowWorker before calling processJob
    await jobsCol.updateOne(
      { workspace: 'ws_acme', clientRef: 'ref_race_1' },
      { $set: { status: 'sending', lockedBy: slowWorker.workerId } }
    );
    await slowWorker.processJob({ ...job!, lockedBy: slowWorker.workerId });

    // Newer worker's lock must remain intact
    const after = await jobsCol.findOne({ workspace: 'ws_acme', clientRef: 'ref_race_1' });
    expect(after?.status).toBe('sending');
    expect(after?.lockedBy).toBe('newer_worker_2');
  });

  it('processes concurrent outbox jobs across two workers with zero duplicates', async () => {
    const refs = Array.from({ length: 8 }, (_, i) => `ref_multi_${i}`);
    await Promise.all(
      refs.map((ref, i) =>
        request(app)
          .post('/__grader/reply')
          .set('x-grader-token', config.graderToken)
          .send({
            workspace: i % 2 === 0 ? 'ws_acme' : 'ws_globex',
            contact: `+1415555080${i}`,
            text: `Concurrent msg ${i}`,
            client_ref: ref,
          })
          .expect(202)
      )
    );

    const delivered: string[] = [];
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const key = headers.get('Idempotency-Key') ?? '';
      delivered.push(key);
      await new Promise((r) => setTimeout(r, 15));
      return new Response(JSON.stringify({ id: `pmsg_${key}`, status: 'queued' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const w1 = new OutboxWorker({ fetchImpl: mockFetch as typeof fetch });
    const w2 = new OutboxWorker({ fetchImpl: mockFetch as typeof fetch });

    w1.start();
    w2.start();
    try {
      await vi.waitFor(() => expect(delivered.length).toBe(refs.length), { timeout: 5000 });
    } finally {
      await Promise.all([w1.stop(), w2.stop()]);
    }

    expect(delivered.sort()).toEqual(refs.sort());
    expect(new Set(delivered).size).toBe(refs.length);
  });

  it('aborts in-flight requests and releases locks immediately on stop()', async () => {
    await request(app)
      .post('/__grader/reply')
      .set('x-grader-token', config.graderToken)
      .send({
        workspace: 'ws_acme',
        contact: '+14155550709',
        text: 'Shutdown test',
        client_ref: 'ref_shutdown_1',
      })
      .expect(202);

    const hangFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })
    );

    const worker = new OutboxWorker({ fetchImpl: hangFetch as typeof fetch, requestTimeoutMs: 14_000 });
    worker.start();

    // Wait until the hang fetch has been invoked
    await vi.waitFor(() => expect(hangFetch).toHaveBeenCalledTimes(1));

    const t0 = Date.now();
    await worker.stop();
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(2000);

    const db = await getDb();
    const job = await db.collection<OutboxJobDoc>(COLLECTIONS.outboxJobs).findOne({
      workspace: 'ws_acme',
      clientRef: 'ref_shutdown_1',
    });
    expect(job?.status).toBe('pending');
    expect(job?.lockedBy).toBeNull();
    expect(job?.lockedUntil).toBeNull();
  });

  it('E2E multi-copy process test: surviving instance delivers replies after instance 1 is killed', async () => {
    const port1 = await getFreePort();
    const port2 = await getFreePort();
    const serverRoot = path.resolve(import.meta.dirname, '..');
    const tsxCli = path.join(serverRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

    const children: ChildProcess[] = [];
    const spawnServer = (port: number) => {
      const child = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
        cwd: serverRoot,
        env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
        stdio: 'ignore',
      });
      children.push(child);
      return child;
    };

    try {
      const proc1 = spawnServer(port1);
      const proc2 = spawnServer(port2);
      await Promise.all([waitForHealth(port1), waitForHealth(port2)]);

      // Send a reply to instance 1
      const replyRes = await fetch(`http://127.0.0.1:${port1}/__grader/reply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-grader-token': config.graderToken,
        },
        body: JSON.stringify({
          workspace: 'ws_acme',
          contact: '+14155550999',
          text: 'E2E multi-copy crash test',
          client_ref: 'ref_e2e_kill_1',
        }),
      });
      expect(replyRes.status).toBe(202);

      // Immediately kill instance 1 without warning
      proc1.kill('SIGKILL');

      // Instance 2 must still be healthy and eventually deliver/track the message in snapshot
      await waitForHealth(port2);
      let found = false;
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const snapRes = await fetch(`http://127.0.0.1:${port2}/__grader/snapshot`, {
          headers: { 'x-grader-token': config.graderToken },
        });
        expect(snapRes.status).toBe(200);
        const snap = (await snapRes.json()) as {
          workspaces: Record<string, { outbound: Record<string, string> }>;
        };
        const entry = snap.workspaces?.ws_acme?.outbound?.ref_e2e_kill_1;
        if (entry === 'queued' || entry === 'sent' || entry === 'delivered') {
          found = true;
          if (entry === 'sent' || entry === 'delivered') break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(found).toBe(true);

      // Cleanly shut down instance 2
      proc2.kill('SIGTERM');
    } finally {
      for (const c of children) {
        try {
          c.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }
  }, 35_000);
});
