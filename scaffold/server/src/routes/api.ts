import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  SESSION_COOKIE,
  getSession,
  parseCookies,
  type SessionUser,
} from '../services/auth.js';
import {
  claimConversation,
  getConversationMessages,
  listConversations,
  setConversationStatus,
} from '../services/conversations.js';
import { enqueueOutboundReply, UnknownWorkspaceError } from '../services/outbound.js';

export interface AuthedRequest extends Request {
  user?: SessionUser;
}

export const apiRouter = Router();

async function requireSession(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE];
  const user = await getSession(sessionId);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  req.user = user;
  next();
}

function getWorkspaceParam(req: Request): string {
  const q = req.query.workspace;
  if (typeof q === 'string' && q.length > 0) return q;
  const b = (req.body as Record<string, unknown> | undefined)?.workspace;
  if (typeof b === 'string' && b.length > 0) return b;
  return '';
}

function requireWorkspaceMember(req: AuthedRequest, res: Response, next: NextFunction): void {
  const workspace = getWorkspaceParam(req);
  if (!workspace) {
    res.status(400).json({ error: 'Missing workspace parameter' });
    return;
  }
  const member = req.user?.workspaces.find((w) => w.id === workspace);
  if (!member) {
    res.status(403).json({ error: 'Forbidden: not a member of this workspace' });
    return;
  }
  next();
}

apiRouter.use(requireSession);

apiRouter.get('/me', (req: AuthedRequest, res: Response) => {
  res.status(200).json(req.user);
});

apiRouter.get('/conversations', requireWorkspaceMember, async (req: AuthedRequest, res: Response) => {
  const workspace = getWorkspaceParam(req);
  const limit = req.query.limit ? Number(req.query.limit) : 50;
  const offset = req.query.offset ? Number(req.query.offset) : 0;

  try {
    const result = await listConversations({ workspace, limit, offset });
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof UnknownWorkspaceError) {
      res.status(404).json({ error: err.message });
      return;
    }
    throw err;
  }
});

apiRouter.get(
  '/conversations/:contact/messages',
  requireWorkspaceMember,
  async (req: AuthedRequest, res: Response) => {
    const workspace = getWorkspaceParam(req);
    const contact = String(req.params.contact);
    const messages = await getConversationMessages(workspace, contact);
    res.status(200).json({ messages });
  }
);

apiRouter.post(
  '/conversations/:contact/claim',
  requireWorkspaceMember,
  async (req: AuthedRequest, res: Response) => {
    const workspace = getWorkspaceParam(req);
    const contact = String(req.params.contact);
    const result = await claimConversation(workspace, contact, req.user!.sub);
    if (result.claimed) {
      res.status(200).json({ ok: true, assignee: result.assignee, conversation: result.conversation });
      return;
    }
    res.status(409).json({ error: 'Already claimed', assignee: result.assignee });
  }
);

apiRouter.post(
  '/conversations/:contact/status',
  requireWorkspaceMember,
  async (req: AuthedRequest, res: Response) => {
    const workspace = getWorkspaceParam(req);
    const contact = String(req.params.contact);
    const status = (req.body as { status?: unknown } | undefined)?.status;
    if (status !== 'open' && status !== 'closed') {
      res.status(400).json({ error: 'status must be open or closed' });
      return;
    }
    const conversation = await setConversationStatus(workspace, contact, status);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.status(200).json({ ok: true, conversation });
  }
);

apiRouter.post(
  '/conversations/:contact/reply',
  requireWorkspaceMember,
  async (req: AuthedRequest, res: Response) => {
    const workspace = getWorkspaceParam(req);
    const contact = String(req.params.contact);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof body.text === 'string' ? body.text : '';
    const clientRef =
      typeof body.client_ref === 'string' && body.client_ref.length > 0
        ? body.client_ref
        : `ui_${crypto.randomUUID()}`;

    if (!text) {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    await enqueueOutboundReply({ workspace, contact, text, clientRef });
    res.status(202).json({ ok: true, client_ref: clientRef });
  }
);
