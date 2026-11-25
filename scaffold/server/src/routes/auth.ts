import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import {
  SESSION_COOKIE,
  consumeAuthTransaction,
  createAuthTransaction,
  createSession,
  deleteSession,
  getOidcDiscovery,
  parseCookies,
  verifyIdToken,
} from '../services/auth.js';

export const authRouter = Router();

authRouter.get('/login', async (req: Request, res: Response) => {
  try {
    const discovery = await getOidcDiscovery();
    const redirectAfter =
      typeof req.query.redirect === 'string' && req.query.redirect.startsWith('/')
        ? req.query.redirect
        : config.webOrigin;

    const { state, nonce, codeChallenge } = await createAuthTransaction(redirectAfter);

    const authUrl = new URL(discovery.authorization_endpoint);
    authUrl.searchParams.set('client_id', config.oidc.clientId);
    authUrl.searchParams.set('redirect_uri', config.oidc.redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid profile email');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('nonce', nonce);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    res.redirect(302, authUrl.toString());
  } catch (err) {
    console.error('auth login error:', err);
    res.status(502).json({ error: 'OIDC login unavailable' });
  }
});

authRouter.get('/callback', async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';

  if (!code || !state) {
    res.status(400).json({ error: 'Missing code or state' });
    return;
  }

  const tx = await consumeAuthTransaction(state);
  if (!tx) {
    res.status(400).json({ error: 'Invalid or expired auth state' });
    return;
  }

  try {
    const discovery = await getOidcDiscovery();
    const tokenRes = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.oidc.redirectUri,
        client_id: config.oidc.clientId,
        client_secret: config.oidc.clientSecret,
        code_verifier: tx.codeVerifier,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      res.status(401).json({ error: 'Token exchange failed', detail: errText });
      return;
    }

    const tokenBody = (await tokenRes.json()) as { id_token?: string };
    if (!tokenBody.id_token) {
      res.status(401).json({ error: 'Missing id_token' });
      return;
    }

    const user = await verifyIdToken(tokenBody.id_token, tx.nonce);
    const sessionId = await createSession(user);

    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 86_400_000,
    });
    res.redirect(302, tx.redirectAfter || config.webOrigin);
  } catch (err) {
    console.error('auth callback error:', err);
    res.status(401).json({ error: 'Authentication failed' });
  }
});

authRouter.post('/logout', async (req: Request, res: Response) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE];
  if (sessionId) {
    await deleteSession(sessionId);
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.status(200).json({ ok: true });
});
