import { Router, type Request, type Response, type NextFunction } from 'express';
import { config } from '../config.js';
import { COLLECTIONS, getDb } from '../db.js';
import { getRedis } from '../redis.js';
import type { ConversationDoc, GraderSnapshot, MessageDoc } from '../types.js';

export const graderRouter = Router();

function requireGraderToken(req: Request, res: Response, next: NextFunction): void {
  const token = req.header('x-grader-token');
  if (!token || token !== config.graderToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

graderRouter.use(requireGraderToken);

graderRouter.post('/reset', async (_req: Request, res: Response) => {
  const db = await getDb();
  await Promise.all([
    db.collection(COLLECTIONS.conversations).deleteMany({}),
    db.collection(COLLECTIONS.messages).deleteMany({}),
    db.collection(COLLECTIONS.webhookEvents).deleteMany({}),
    db.collection(COLLECTIONS.outboxJobs).deleteMany({}),
    db.collection(COLLECTIONS.wsEvents).deleteMany({}),
  ]);

  const redis = getRedis();
  const appPrefixes = ['ws:seq:', 'ratelimit:', 'pigeon:'];
  for (const prefix of appPrefixes) {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  }

  res.status(200).json({ ok: true });
});

graderRouter.get('/snapshot', async (_req: Request, res: Response) => {
  const db = await getDb();
  const [conversations, messages] = await Promise.all([
    db.collection<ConversationDoc>(COLLECTIONS.conversations).find({}).toArray(),
    db
      .collection<MessageDoc>(COLLECTIONS.messages)
      .find({})
      .sort({ occurredAt: 1, _id: 1 })
      .toArray(),
  ]);

  const snapshot: GraderSnapshot = { workspaces: {} };

  const ensureWorkspace = (ws: string) => {
    if (!snapshot.workspaces[ws]) {
      snapshot.workspaces[ws] = { contacts: {}, outbound: {} };
    }
    return snapshot.workspaces[ws];
  };

  for (const conv of conversations) {
    const ws = ensureWorkspace(conv.workspace);
    ws.contacts[conv.contact] = {
      inbound: [],
      assignee: conv.assignee ?? null,
    };
  }

  for (const msg of messages) {
    const ws = ensureWorkspace(msg.workspace);
    if (msg.direction === 'inbound') {
      if (!ws.contacts[msg.contact]) {
        ws.contacts[msg.contact] = { inbound: [], assignee: null };
      }
      if (msg.pigeonMessageId) {
        ws.contacts[msg.contact].inbound.push(msg.pigeonMessageId);
      }
    } else if (msg.direction === 'outbound' && msg.clientRef) {
      ws.outbound[msg.clientRef] = msg.status ?? 'queued';
    }
  }

  res.status(200).json(snapshot);
});
