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
import {
  createEncryptedNote,
  getWorkspaceKeyBundle,
  listEncryptedNotes,
  registerAgentPublicKey,
  storeWorkspaceKeyEnvelope,
} from '../services/notes.js';
import { enqueueOutboundReply, UnknownWorkspaceError } from '../services/outbound.js';
import { searchWorkspaceMessages } from '../services/search.js';

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

// --- Module 8: E2EE Private Notes & Key Distribution ---
apiRouter.post('/keys/register', async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!body.publicKeyJwk || typeof body.publicKeyJwk !== 'object') {
    res.status(400).json({ error: 'publicKeyJwk is required' });
    return;
  }
  await registerAgentPublicKey(req.user!.sub, body.publicKeyJwk as Record<string, unknown>);
  res.status(200).json({ ok: true });
});

apiRouter.get('/keys/workspace', requireWorkspaceMember, async (req: AuthedRequest, res: Response) => {
  const workspace = getWorkspaceParam(req);
  const bundle = await getWorkspaceKeyBundle(workspace, req.user!.sub);
  res.status(200).json(bundle);
});

apiRouter.post('/keys/wrap', requireWorkspaceMember, async (req: AuthedRequest, res: Response) => {
  const workspace = getWorkspaceParam(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { recipientSub, keyVersion, wrappedKey, ephemeralPublicKeyJwk, iv } = body;
  if (
    typeof recipientSub !== 'string' ||
    !recipientSub ||
    typeof keyVersion !== 'number' ||
    typeof wrappedKey !== 'string' ||
    !wrappedKey ||
    !ephemeralPublicKeyJwk ||
    typeof ephemeralPublicKeyJwk !== 'object' ||
    typeof iv !== 'string' ||
    !iv
  ) {
    res.status(400).json({ error: 'Invalid wrapped key envelope' });
    return;
  }

  await storeWorkspaceKeyEnvelope({
    workspace,
    recipientSub,
    senderSub: req.user!.sub,
    keyVersion,
    wrappedKey,
    ephemeralPublicKeyJwk: ephemeralPublicKeyJwk as Record<string, unknown>,
    iv,
  });
  res.status(200).json({ ok: true });
});

apiRouter.get(
  '/conversations/:contact/notes',
  requireWorkspaceMember,
  async (req: AuthedRequest, res: Response) => {
    const workspace = getWorkspaceParam(req);
    const contact = String(req.params.contact);
    const notes = await listEncryptedNotes(workspace, contact);
    res.status(200).json({ notes });
  }
);

apiRouter.post(
  '/conversations/:contact/notes',
  requireWorkspaceMember,
  async (req: AuthedRequest, res: Response) => {
    const workspace = getWorkspaceParam(req);
    const contact = String(req.params.contact);
    const body = (req.body ?? {}) as Record<string, unknown>;

    if ('plaintext' in body || 'text' in body) {
      res.status(400).json({ error: 'Plaintext notes are forbidden; encrypt client-side' });
      return;
    }

    const { ciphertext, iv, aad, keyVersion } = body;
    if (
      typeof ciphertext !== 'string' ||
      !ciphertext ||
      typeof iv !== 'string' ||
      !iv ||
      typeof aad !== 'string' ||
      !aad ||
      typeof keyVersion !== 'number'
    ) {
      res.status(400).json({ error: 'Missing required encrypted note fields' });
      return;
    }

    const note = await createEncryptedNote({
      workspace,
      contact,
      authorSub: req.user!.sub,
      ciphertext,
      iv,
      aad,
      keyVersion,
    });
    res.status(201).json({ note });
  }
);

// --- Module 9: Workspace-Scoped Search ---
apiRouter.get('/search', requireWorkspaceMember, async (req: AuthedRequest, res: Response) => {
  const workspace = getWorkspaceParam(req);
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const limit = req.query.limit ? Number(req.query.limit) : 25;
  const result = await searchWorkspaceMessages(workspace, q, limit);
  res.status(200).json(result);
});
