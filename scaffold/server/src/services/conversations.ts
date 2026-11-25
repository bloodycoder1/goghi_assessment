import { config } from '../config.js';
import { COLLECTIONS, getDb } from '../db.js';
import type { ConversationDoc, ConversationStatus, MessageDoc } from '../types.js';
import { UnknownWorkspaceError } from './outbound.js';
import { publishWorkspaceEvent } from './realtime.js';

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export interface ClaimResult {
  claimed: boolean;
  assignee: string | null;
  conversation: ConversationDoc | null;
}

export async function claimConversation(
  workspace: string,
  contact: string,
  agent: string
): Promise<ClaimResult> {
  if (!(workspace in config.pigeon.apiKeys)) {
    throw new UnknownWorkspaceError(workspace);
  }

  const db = await getDb();
  const col = db.collection<ConversationDoc>(COLLECTIONS.conversations);
  const now = new Date();

  const tryAtomicClaim = async (): Promise<ConversationDoc | null> =>
    col.findOneAndUpdate(
      {
        workspace,
        contact,
        $or: [{ assignee: null }, { assignee: agent }],
      },
      {
        $set: { assignee: agent, updatedAt: now },
      },
      { returnDocument: 'after' }
    );

  const updated = await tryAtomicClaim();
  if (updated) {
    await publishWorkspaceEvent(workspace, 'conversation.assigned', {
      contact,
      assignee: updated.assignee,
    });
    return { claimed: true, assignee: updated.assignee, conversation: updated };
  }

  const existing = await col.findOne({ workspace, contact });
  if (existing) {
    return { claimed: false, assignee: existing.assignee, conversation: existing };
  }

  // Conversation does not exist yet: insert atomically, handling concurrent creation
  const newDoc: ConversationDoc = {
    workspace,
    contact,
    assignee: agent,
    status: 'open',
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await col.insertOne(newDoc);
    await publishWorkspaceEvent(workspace, 'conversation.assigned', {
      contact,
      assignee: agent,
    });
    return { claimed: true, assignee: agent, conversation: newDoc };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;

    const retry = await tryAtomicClaim();
    if (retry) {
      await publishWorkspaceEvent(workspace, 'conversation.assigned', {
        contact,
        assignee: retry.assignee,
      });
      return { claimed: true, assignee: retry.assignee, conversation: retry };
    }
    const winner = await col.findOne({ workspace, contact });
    return {
      claimed: false,
      assignee: winner?.assignee ?? null,
      conversation: winner,
    };
  }
}

export async function setConversationStatus(
  workspace: string,
  contact: string,
  status: ConversationStatus
): Promise<ConversationDoc | null> {
  if (!(workspace in config.pigeon.apiKeys)) {
    throw new UnknownWorkspaceError(workspace);
  }
  const db = await getDb();
  const updated = await db.collection<ConversationDoc>(COLLECTIONS.conversations).findOneAndUpdate(
    { workspace, contact },
    { $set: { status, updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (updated) {
    await publishWorkspaceEvent(workspace, 'conversation.status', {
      contact,
      status,
    });
  }
  return updated;
}

export interface ListConversationsOptions {
  workspace: string;
  limit?: number;
  offset?: number;
}

export async function listConversations(
  options: ListConversationsOptions
): Promise<{ conversations: ConversationDoc[]; total: number }> {
  const { workspace, limit = 50, offset = 0 } = options;
  if (!(workspace in config.pigeon.apiKeys)) {
    throw new UnknownWorkspaceError(workspace);
  }
  const db = await getDb();
  const col = db.collection<ConversationDoc>(COLLECTIONS.conversations);
  const safeLimit = Math.min(100, Math.max(1, limit));
  const safeOffset = Math.max(0, offset);

  const [conversations, total] = await Promise.all([
    col
      .find({ workspace })
      .sort({ lastActivityAt: -1, _id: -1 })
      .skip(safeOffset)
      .limit(safeLimit)
      .toArray(),
    col.countDocuments({ workspace }),
  ]);

  return { conversations, total };
}

export async function getConversationMessages(
  workspace: string,
  contact: string
): Promise<MessageDoc[]> {
  if (!(workspace in config.pigeon.apiKeys)) {
    throw new UnknownWorkspaceError(workspace);
  }
  const db = await getDb();
  return db
    .collection<MessageDoc>(COLLECTIONS.messages)
    .find({ workspace, contact })
    .sort({ occurredAt: 1, _id: 1 })
    .toArray();
}
