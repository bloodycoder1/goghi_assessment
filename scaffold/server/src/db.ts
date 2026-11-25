import { MongoClient, type Db } from 'mongodb';
import { config } from './config.js';

let client: MongoClient | undefined;
let indexesPromise: Promise<void> | undefined;

export const COLLECTIONS = {
  conversations: 'conversations',
  messages: 'messages',
  webhookEvents: 'webhook_events',
  outboxJobs: 'outbox_jobs',
  wsEvents: 'ws_events',
} as const;

// Connects on first use. Call from anywhere: const db = await getDb();
export async function getDb(): Promise<Db> {
  if (!client) {
    client = new MongoClient(config.mongoUrl);
    await client.connect();
  }
  return client.db();
}

export async function ensureIndexes(): Promise<void> {
  if (!indexesPromise) {
    indexesPromise = (async () => {
      const db = await getDb();
      await Promise.all([
        db.collection(COLLECTIONS.conversations).createIndex(
          { workspace: 1, contact: 1 },
          { unique: true }
        ),
        db.collection(COLLECTIONS.conversations).createIndex({
          workspace: 1,
          lastActivityAt: -1,
        }),
        db.collection(COLLECTIONS.messages).createIndex({
          workspace: 1,
          contact: 1,
          occurredAt: 1,
          _id: 1,
        }),
        db.collection(COLLECTIONS.messages).createIndex(
          { workspace: 1, clientRef: 1 },
          { unique: true, partialFilterExpression: { clientRef: { $type: 'string' } } }
        ),
        db.collection(COLLECTIONS.messages).createIndex(
          { workspace: 1, pigeonMessageId: 1 },
          {
            unique: true,
            partialFilterExpression: { pigeonMessageId: { $type: 'string' } },
          }
        ),
        db.collection(COLLECTIONS.webhookEvents).createIndex(
          { eventId: 1 },
          { unique: true }
        ),
        db.collection(COLLECTIONS.outboxJobs).createIndex(
          { workspace: 1, clientRef: 1 },
          { unique: true }
        ),
        db.collection(COLLECTIONS.outboxJobs).createIndex({
          status: 1,
          nextRunAt: 1,
        }),
        db.collection(COLLECTIONS.wsEvents).createIndex(
          { workspace: 1, seq: 1 },
          { unique: true }
        ),
      ]);
    })();
  }
  return indexesPromise;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = undefined;
    indexesPromise = undefined;
  }
}
