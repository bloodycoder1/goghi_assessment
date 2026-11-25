import { Router, type Request, type Response, type NextFunction } from 'express';
import { config } from '../config.js';
import { COLLECTIONS, getDb } from '../db.js';
import { getRedis } from '../redis.js';
import {
  canWorkspaceSend,
  isWorkspaceSendAllowed,
  subscribeWorkspace,
  updateWorkspaceSeats,
} from '../services/billing.js';
import { claimConversation } from '../services/conversations.js';
import { enqueueOutboundReply, UnknownWorkspaceError } from '../services/outbound.js';
import type { BillingWorkspaceDoc, ConversationDoc, GraderSnapshot, MessageDoc } from '../types.js';

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
    db.collection(COLLECTIONS.privateNotes).deleteMany({}),
    db.collection(COLLECTIONS.agentKeys).deleteMany({}),
    db.collection(COLLECTIONS.workspaceKeyEnvelopes).deleteMany({}),
    db.collection(COLLECTIONS.billingWorkspaces).deleteMany({}),
  ]);

  const redis = getRedis();
  const appPrefixes = ['ws:seq:', 'ratelimit:', 'pigeon:', 'billing:'];
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
  const [conversations, messages, billings] = await Promise.all([
    db.collection<ConversationDoc>(COLLECTIONS.conversations).find({}).toArray(),
    db
      .collection<MessageDoc>(COLLECTIONS.messages)
      .find({})
      .sort({ occurredAt: 1, _id: 1 })
      .toArray(),
    db.collection<BillingWorkspaceDoc>(COLLECTIONS.billingWorkspaces).find({}).toArray(),
  ]);

  const snapshot: GraderSnapshot = { workspaces: {} };

  const ensureWorkspace = (ws: string) => {
    if (!snapshot.workspaces[ws]) {
      snapshot.workspaces[ws] = {
        contacts: {},
        outbound: {},
        billing: { status: 'none', seats: 0, can_send: true },
      };
    }
    return snapshot.workspaces[ws];
  };

  for (const b of billings) {
    const ws = ensureWorkspace(b.workspace);
    ws.billing = {
      status: b.status,
      seats: b.seats,
      can_send: canWorkspaceSend(b.status),
    };
  }

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

graderRouter.post('/reply', async (req: Request, res: Response) => {
  const { workspace, contact, text, client_ref } = (req.body ?? {}) as Record<string, unknown>;
  if (
    typeof workspace !== 'string' ||
    !workspace ||
    typeof contact !== 'string' ||
    !contact ||
    typeof text !== 'string' ||
    !text ||
    typeof client_ref !== 'string' ||
    !client_ref
  ) {
    res.status(400).json({ error: 'Missing required fields: workspace, contact, text, client_ref' });
    return;
  }

  try {
    if (!(await isWorkspaceSendAllowed(workspace))) {
      res.status(402).json({ error: 'Subscription canceled or incomplete; sending disabled' });
      return;
    }
    await enqueueOutboundReply({
      workspace,
      contact,
      text,
      clientRef: client_ref,
    });
    res.status(202).json({ ok: true, client_ref });
  } catch (err) {
    if (err instanceof UnknownWorkspaceError) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error('grader reply error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

graderRouter.post('/claim', async (req: Request, res: Response) => {
  const { workspace, contact, agent } = (req.body ?? {}) as Record<string, unknown>;
  if (
    typeof workspace !== 'string' ||
    !workspace ||
    typeof contact !== 'string' ||
    !contact ||
    typeof agent !== 'string' ||
    !agent
  ) {
    res.status(400).json({ error: 'Missing required fields: workspace, contact, agent' });
    return;
  }

  try {
    const result = await claimConversation(workspace, contact, agent);
    if (result.claimed) {
      res.status(200).json({ ok: true, assignee: result.assignee });
      return;
    }
    res.status(409).json({ error: 'Already claimed', assignee: result.assignee });
  } catch (err) {
    if (err instanceof UnknownWorkspaceError) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error('grader claim error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

graderRouter.post('/billing/subscribe', async (req: Request, res: Response) => {
  const { workspace, seats, token } = (req.body ?? {}) as Record<string, unknown>;
  if (
    typeof workspace !== 'string' ||
    !workspace ||
    typeof seats !== 'number' ||
    seats < 1 ||
    typeof token !== 'string' ||
    !token
  ) {
    res.status(400).json({ error: 'Missing required fields: workspace, seats, token' });
    return;
  }

  try {
    const result = await subscribeWorkspace({ workspace, seats, token });
    res.status(result.statusCode).json(result.billing);
  } catch (err) {
    if (err instanceof UnknownWorkspaceError) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error('grader billing subscribe error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

graderRouter.post('/billing/seats', async (req: Request, res: Response) => {
  const { workspace, seats } = (req.body ?? {}) as Record<string, unknown>;
  if (
    typeof workspace !== 'string' ||
    !workspace ||
    typeof seats !== 'number' ||
    seats < 1
  ) {
    res.status(400).json({ error: 'Missing required fields: workspace, seats' });
    return;
  }

  try {
    const result = await updateWorkspaceSeats({ workspace, seats });
    res.status(result.statusCode).json(result.billing);
  } catch (err) {
    if (err instanceof UnknownWorkspaceError) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error('grader billing seats error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});
