import { config } from '../config.js';
import { COLLECTIONS, getDb } from '../db.js';
import type { ConversationDoc, MessageDoc, OutboxJobDoc } from '../types.js';

export interface EnqueueReplyInput {
  workspace: string;
  contact: string;
  text: string;
  clientRef: string;
}

export class UnknownWorkspaceError extends Error {
  constructor(workspace: string) {
    super(`Unknown workspace: ${workspace}`);
    this.name = 'UnknownWorkspaceError';
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

let onEnqueuedHook: (() => void) | undefined;

export function setOnEnqueuedHook(fn: (() => void) | undefined): void {
  onEnqueuedHook = fn;
}

export async function enqueueOutboundReply(input: EnqueueReplyInput): Promise<void> {
  const { workspace, contact, text, clientRef } = input;
  if (!(workspace in config.pigeon.apiKeys)) {
    throw new UnknownWorkspaceError(workspace);
  }

  const db = await getDb();
  const now = new Date();

  // Enqueue durable outbox job first so a mid-request crash never leaves an orphaned message without a job
  try {
    await db.collection<OutboxJobDoc>(COLLECTIONS.outboxJobs).insertOne({
      workspace,
      contact,
      text,
      clientRef,
      status: 'pending',
      attempts: 0,
      nextRunAt: now,
      lockedUntil: null,
      lockedBy: null,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }

  // Ensure conversation exists even if contact has not written yet
  await db.collection<ConversationDoc>(COLLECTIONS.conversations).updateOne(
    { workspace, contact },
    {
      $setOnInsert: {
        workspace,
        contact,
        assignee: null,
        status: 'open',
        createdAt: now,
      },
      $max: { lastActivityAt: now },
      $set: { updatedAt: now },
    },
    { upsert: true }
  );

  // Store outbound message idempotently
  try {
    await db.collection<MessageDoc>(COLLECTIONS.messages).insertOne({
      workspace,
      contact,
      direction: 'outbound',
      text,
      clientRef,
      status: 'queued',
      occurredAt: now,
      createdAt: now,
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }

  onEnqueuedHook?.();
}
