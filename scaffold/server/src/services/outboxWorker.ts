import crypto from 'node:crypto';
import { config } from '../config.js';
import { COLLECTIONS, getDb } from '../db.js';
import type { MessageDoc, OutboxJobDoc } from '../types.js';
import { setOnEnqueuedHook } from './outbound.js';
import {
  acquireWorkspaceSendToken,
  markWorkspaceRateLimited,
} from './rateLimiter.js';

const LEASE_MS = 18_000;
const REQUEST_TIMEOUT_MS = 14_000;
const IDLE_POLL_MS = 150;

export interface OutboxWorkerOptions {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  leaseMs?: number;
}

export class OutboxWorker {
  readonly workerId = `worker_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly leaseMs: number;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private processing = false;
  private inFlightAbort: AbortController | null = null;

  constructor(options: OutboxWorkerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.leaseMs = options.leaseMs ?? LEASE_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    setOnEnqueuedHook(() => this.trigger());
    this.scheduleNext(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    setOnEnqueuedHook(undefined);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlightAbort) {
      this.inFlightAbort.abort();
    }
    // Wait briefly if a job tick is currently in flight
    const deadline = Date.now() + 3000;
    while (this.processing && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    // Release any jobs still leased by this worker so surviving copies can pick them up immediately
    try {
      const db = await getDb();
      await db.collection<OutboxJobDoc>(COLLECTIONS.outboxJobs).updateMany(
        { status: 'sending', lockedBy: this.workerId },
        {
          $set: {
            status: 'pending',
            lockedUntil: null,
            lockedBy: null,
            nextRunAt: new Date(),
            updatedAt: new Date(),
          },
        }
      );
    } catch {
      // ignore if DB already closed
    }
  }

  trigger(): void {
    if (!this.running || this.processing) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduleNext(0);
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  async tick(): Promise<boolean> {
    if (!this.running || this.processing) return false;
    this.processing = true;
    let processedAny = false;

    try {
      while (this.running) {
        const job = await this.claimNextJob();
        if (!job) break;
        processedAny = true;
        await this.processJob(job);
      }
    } catch (err) {
      console.error('outbox worker tick error:', err);
    } finally {
      this.processing = false;
      if (this.running) {
        this.scheduleNext(IDLE_POLL_MS);
      }
    }

    return processedAny;
  }

  private async claimNextJob(): Promise<OutboxJobDoc | null> {
    const db = await getDb();
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + this.leaseMs);

    return db.collection<OutboxJobDoc>(COLLECTIONS.outboxJobs).findOneAndUpdate(
      {
        status: { $in: ['pending', 'sending'] },
        nextRunAt: { $lte: now },
        $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
      },
      {
        $set: {
          status: 'sending',
          lockedUntil: leaseUntil,
          lockedBy: this.workerId,
          updatedAt: now,
        },
        $inc: { attempts: 1 },
      },
      {
        sort: { nextRunAt: 1, createdAt: 1 },
        returnDocument: 'after',
      }
    );
  }

  async processJob(job: OutboxJobDoc): Promise<void> {
    const db = await getDb();
    const jobsCol = db.collection<OutboxJobDoc>(COLLECTIONS.outboxJobs);
    const messagesCol = db.collection<MessageDoc>(COLLECTIONS.messages);

    const apiKey = config.pigeon.apiKeys[job.workspace];
    if (!apiKey) {
      await jobsCol.updateOne(
        { workspace: job.workspace, clientRef: job.clientRef },
        { $set: { status: 'failed', lockedUntil: null, lockedBy: null, updatedAt: new Date() } }
      );
      return;
    }

    const rate = await acquireWorkspaceSendToken(job.workspace);
    if (!rate.allowed) {
      await jobsCol.updateOne(
        { workspace: job.workspace, clientRef: job.clientRef, lockedBy: this.workerId },
        {
          $set: {
            status: 'pending',
            lockedUntil: null,
            lockedBy: null,
            nextRunAt: new Date(Date.now() + rate.waitMs),
            updatedAt: new Date(),
          },
          $inc: { attempts: -1 },
        }
      );
      return;
    }

    const abortController = new AbortController();
    this.inFlightAbort = abortController;

    try {
      const response = await this.fetchImpl(`${config.pigeon.url}/v1/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': job.clientRef,
        },
        body: JSON.stringify({
          to: job.contact,
          text: job.text,
          client_ref: job.clientRef,
        }),
        signal: AbortSignal.any([
          abortController.signal,
          AbortSignal.timeout(this.requestTimeoutMs),
        ]),
      });

      if (response.ok) {
        let pigeonId: string | undefined;
        try {
          const body = (await response.json()) as { id?: unknown };
          if (typeof body.id === 'string') pigeonId = body.id;
        } catch {
          // ignore non-json 2xx body
        }

        await jobsCol.updateOne(
          { workspace: job.workspace, clientRef: job.clientRef },
          {
            $set: {
              status: 'done',
              lockedUntil: null,
              lockedBy: null,
              updatedAt: new Date(),
            },
          }
        );

        if (pigeonId) {
          await messagesCol.updateOne(
            { workspace: job.workspace, direction: 'outbound', clientRef: job.clientRef },
            { $set: { pigeonMessageId: pigeonId } }
          );
        }
        return;
      }

      if (response.status === 429) {
        const retryAfterRaw = response.headers.get('retry-after');
        const retryAfterSec = retryAfterRaw ? Math.max(0.25, Number(retryAfterRaw) || 1) : 1;
        await markWorkspaceRateLimited(job.workspace, retryAfterSec);

        await jobsCol.updateOne(
          { workspace: job.workspace, clientRef: job.clientRef, lockedBy: this.workerId },
          {
            $set: {
              status: 'pending',
              lockedUntil: null,
              lockedBy: null,
              nextRunAt: new Date(Date.now() + Math.ceil(retryAfterSec * 1000) + 50),
              updatedAt: new Date(),
            },
          }
        );
        return;
      }

      if (response.status >= 400 && response.status < 500) {
        await jobsCol.updateOne(
          { workspace: job.workspace, clientRef: job.clientRef, lockedBy: this.workerId },
          {
            $set: {
              status: 'failed',
              lockedUntil: null,
              lockedBy: null,
              updatedAt: new Date(),
            },
          }
        );
        await messagesCol.updateOne(
          {
            workspace: job.workspace,
            direction: 'outbound',
            clientRef: job.clientRef,
            status: { $in: ['queued', 'sent'] },
          },
          { $set: { status: 'failed' } }
        );
        return;
      }

      // 5xx (e.g. 503 outage): retry with bounded exponential backoff
      const backoffMs = Math.min(3000, 250 * 2 ** Math.min(job.attempts, 4));
      await jobsCol.updateOne(
        { workspace: job.workspace, clientRef: job.clientRef, lockedBy: this.workerId },
        {
          $set: {
            status: 'pending',
            lockedUntil: null,
            lockedBy: null,
            nextRunAt: new Date(Date.now() + backoffMs),
            updatedAt: new Date(),
          },
        }
      );
    } catch {
      // Network error, abort, or 12s+ timeout: retry with same Idempotency-Key
      const backoffMs = abortController.signal.aborted
        ? 0
        : Math.min(3000, 250 * 2 ** Math.min(job.attempts, 4));
      await jobsCol.updateOne(
        { workspace: job.workspace, clientRef: job.clientRef, lockedBy: this.workerId },
        {
          $set: {
            status: 'pending',
            lockedUntil: null,
            lockedBy: null,
            nextRunAt: new Date(Date.now() + backoffMs),
            updatedAt: new Date(),
          },
        }
      );
    } finally {
      if (this.inFlightAbort === abortController) {
        this.inFlightAbort = null;
      }
    }
  }
}
