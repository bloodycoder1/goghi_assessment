import crypto from 'node:crypto';
import { config } from '../config.js';
import { getRedis } from '../redis.js';

export const SESSION_COOKIE = 'sb_session';
const TX_TTL_SEC = 300;
const SESSION_TTL_SEC = 86_400;

export interface WorkspaceMembership {
  id: string;
  role: 'admin' | 'agent' | string;
}

export interface SessionUser {
  sub: string;
  name?: string;
  email?: string;
  workspaces: WorkspaceMembership[];
}

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
}

interface AuthTransaction {
  codeVerifier: string;
  nonce: string;
  redirectAfter: string;
}

let cachedDiscovery: OidcDiscovery | undefined;
let cachedJwks: Map<string, crypto.JsonWebKey> | undefined;

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      result[key] = decodeURIComponent(val);
    } catch {
      result[key] = val;
    }
  }
  return result;
}

export async function getOidcDiscovery(): Promise<OidcDiscovery> {
  if (cachedDiscovery) return cachedDiscovery;
  const res = await fetch(`${config.oidc.issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: ${res.status}`);
  }
  cachedDiscovery = (await res.json()) as OidcDiscovery;
  return cachedDiscovery;
}

async function getJwkByKid(jwksUri: string, kid: string | undefined): Promise<crypto.JsonWebKey> {
  if (!cachedJwks || (kid && !cachedJwks.has(kid))) {
    const res = await fetch(jwksUri, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const body = (await res.json()) as { keys: Array<crypto.JsonWebKey & { kid?: string }> };
    cachedJwks = new Map();
    for (const k of body.keys ?? []) {
      if (k.kid) cachedJwks.set(k.kid, k);
      else cachedJwks.set('default', k);
    }
  }
  const key = (kid ? cachedJwks.get(kid) : undefined) ?? cachedJwks.values().next().value;
  if (!key) throw new Error('No matching JWK found');
  return key;
}

export async function verifyIdToken(idToken: string, expectedNonce: string): Promise<SessionUser> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Invalid id_token format');
  const [headB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(Buffer.from(headB64, 'base64url').toString('utf8')) as {
    alg?: string;
    kid?: string;
  };
  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported id_token alg: ${header.alg}`);
  }

  const discovery = await getOidcDiscovery();
  const jwk = await getJwkByKid(discovery.jwks_uri, header.kid);
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const verified = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${headB64}.${payloadB64}`),
    publicKey,
    Buffer.from(sigB64, 'base64url')
  );
  if (!verified) {
    throw new Error('Invalid id_token signature');
  }

  const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
    iss?: string;
    aud?: string | string[];
    exp?: number;
    nonce?: string;
    sub?: string;
    name?: string;
    email?: string;
    workspaces?: WorkspaceMembership[];
  };

  if (claims.iss !== discovery.issuer) throw new Error('id_token issuer mismatch');
  const audMatch = Array.isArray(claims.aud)
    ? claims.aud.includes(config.oidc.clientId)
    : claims.aud === config.oidc.clientId;
  if (!audMatch) throw new Error('id_token audience mismatch');
  if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000) - 30) {
    throw new Error('id_token expired');
  }
  if (claims.nonce !== expectedNonce) throw new Error('id_token nonce mismatch');
  if (!claims.sub) throw new Error('id_token missing sub');

  return {
    sub: claims.sub,
    name: claims.name,
    email: claims.email,
    workspaces: Array.isArray(claims.workspaces) ? claims.workspaces : [],
  };
}

export async function createAuthTransaction(redirectAfter: string): Promise<{
  state: string;
  nonce: string;
  codeChallenge: string;
}> {
  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  const tx: AuthTransaction = { codeVerifier, nonce, redirectAfter };
  await getRedis().set(`oidc:tx:${state}`, JSON.stringify(tx), 'EX', TX_TTL_SEC);

  return { state, nonce, codeChallenge };
}

export async function consumeAuthTransaction(state: string): Promise<AuthTransaction | null> {
  const raw = await getRedis().getdel(`oidc:tx:${state}`);
  if (!raw) return null;
  return JSON.parse(raw) as AuthTransaction;
}

export async function createSession(user: SessionUser): Promise<string> {
  const sessionId = crypto.randomBytes(24).toString('hex');
  await getRedis().set(`session:${sessionId}`, JSON.stringify(user), 'EX', SESSION_TTL_SEC);
  return sessionId;
}

export async function getSession(sessionId: string): Promise<SessionUser | null> {
  if (!sessionId) return null;
  const raw = await getRedis().get(`session:${sessionId}`);
  if (!raw) return null;
  return JSON.parse(raw) as SessionUser;
}

export async function deleteSession(sessionId: string): Promise<void> {
  if (!sessionId) return;
  await getRedis().del(`session:${sessionId}`);
}
