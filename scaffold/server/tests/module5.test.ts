import crypto from 'node:crypto';
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { closeDb, ensureIndexes, getDb } from '../src/db.js';
import { closeRedis, getRedis } from '../src/redis.js';
import { attachWebSocketServer, type WsManager } from '../src/wsServer.js';

function signPigeonBody(rawBody: string, timestampSec = Math.floor(Date.now() / 1000)): string {
  const sig = crypto
    .createHmac('sha256', config.pigeon.webhookSecret)
    .update(`${timestampSec}.${rawBody}`)
    .digest('hex');
  return `t=${timestampSec},v1=${sig}`;
}

async function signInAs(baseUrl: string, sub: string): Promise<string> {
  const loginRes = await fetch(`${baseUrl}/auth/login`, { redirect: 'manual' });
  expect(loginRes.status).toBe(302);
  const idpUrl = loginRes.headers.get('location')!;
  expect(idpUrl).toContain(config.oidc.issuer);

  const idpRes = await fetch(`${idpUrl}&login=${sub}`, { redirect: 'manual' });
  expect(idpRes.status).toBe(302);
  const callbackUrl = new URL(idpRes.headers.get('location')!);
  // Route callback through our ephemeral test server port
  const localCallback = `${baseUrl}${callbackUrl.pathname}${callbackUrl.search}`;

  const cbRes = await fetch(localCallback, { redirect: 'manual' });
  expect(cbRes.status).toBe(302);
  const setCookie = cbRes.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  return setCookie!.split(';')[0];
}

describe('Module 5: OIDC + PKCE Auth, Tenant Isolation & WebSockets', () => {
  let server: Server;
  let wsManager: WsManager;
  let baseUrl: string;
  let wsBaseUrl: string;

  beforeAll(async () => {
    await getDb();
    await ensureIndexes();
    await getRedis().ping();

    const app = createApp();
    server = createServer(app);
    wsManager = attachWebSocketServer(server);

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    wsBaseUrl = `ws://127.0.0.1:${port}`;
    // Ensure OIDC redirect_uri matches registered localhost:4000 or current callback
    // Mock IdP has http://localhost:4000/auth/callback registered; callback URL is rewritten to baseUrl above.
  });

  beforeEach(async () => {
    await request(baseUrl)
      .post('/__grader/reset')
      .set('x-grader-token', config.graderToken)
      .expect(200);
  });

  afterAll(async () => {
    await wsManager.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled([closeDb(), closeRedis()]);
  });

  it('completes OIDC + PKCE login via Mock IdP and enforces /api/me & tenant isolation', async () => {
    // Unauthenticated /api/me -> 401
    const anonMe = await fetch(`${baseUrl}/api/me`);
    expect(anonMe.status).toBe(401);

    const cookie = await signInAs(baseUrl, 'u_ben');

    const meRes = await fetch(`${baseUrl}/api/me`, { headers: { cookie } });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { sub: string; workspaces: Array<{ id: string; role: string }> };
    expect(me.sub).toBe('u_ben');
    expect(me.workspaces).toEqual([{ id: 'ws_acme', role: 'agent' }]);

    // Tenant isolation on /api/conversations
    const own = await fetch(`${baseUrl}/api/conversations?workspace=ws_acme`, { headers: { cookie } });
    expect(own.status).toBe(200);

    const other = await fetch(`${baseUrl}/api/conversations?workspace=ws_globex`, { headers: { cookie } });
    expect(other.status).toBe(403);

    const noSess = await fetch(`${baseUrl}/api/conversations?workspace=ws_acme`);
    expect(noSess.status).toBe(401);
  });

  it('refuses unauthorized WebSocket upgrades and streams live + replayed frames with monotonic seq', async () => {
    const cookie = await signInAs(baseUrl, 'u_ben');

    // No cookie -> refused
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${wsBaseUrl}/ws?workspace=ws_acme`);
        ws.on('open', () => {
          ws.close();
          reject(new Error('Should not open without session'));
        });
        ws.on('error', () => resolve());
      })
    ).resolves.toBeUndefined();

    // Wrong workspace -> refused
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${wsBaseUrl}/ws?workspace=ws_globex`, {
          headers: { cookie },
        });
        ws.on('open', () => {
          ws.close();
          reject(new Error('Should not open for non-member workspace'));
        });
        ws.on('error', () => resolve());
      })
    ).resolves.toBeUndefined();

    // Valid connection -> receives live frames
    const liveFrames: Array<{ seq: number; type: string }> = [];
    const ws = new WebSocket(`${wsBaseUrl}/ws?workspace=ws_acme`, {
      headers: { cookie },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.on('message', (data) => {
      liveFrames.push(JSON.parse(data.toString('utf8')));
    });

    const evt1 = JSON.stringify({
      id: 'evt_ws_1',
      type: 'message.inbound',
      workspace: 'ws_acme',
      occurred_at: '2026-11-18T11:00:00.000Z',
      data: { message_id: 'pmsg_ws_1', from: '+14155550101', text: 'live msg' },
    });
    await request(baseUrl)
      .post('/webhooks/pigeon')
      .set('content-type', 'application/json')
      .set('x-pigeon-signature', signPigeonBody(evt1))
      .send(evt1)
      .expect(200);

    await new Promise((r) => setTimeout(r, 150));
    expect(liveFrames.length).toBeGreaterThanOrEqual(1);
    const seq1 = liveFrames[0].seq;
    expect(liveFrames[0].type).toBe('message.inbound');

    ws.close();

    // Trigger another event while disconnected (claim)
    await request(baseUrl)
      .post('/__grader/claim')
      .set('x-grader-token', config.graderToken)
      .send({ workspace: 'ws_acme', contact: '+14155550101', agent: 'u_ben' })
      .expect(200);

    // Reconnect with &after=seq1 -> must replay the missed conversation.assigned frame
    const replayed: Array<{ seq: number; type: string }> = [];
    const ws2 = new WebSocket(`${wsBaseUrl}/ws?workspace=ws_acme&after=${seq1}`, {
      headers: { cookie },
    });
    await new Promise<void>((resolve, reject) => {
      ws2.on('open', () => resolve());
      ws2.on('error', reject);
    });
    ws2.on('message', (data) => {
      replayed.push(JSON.parse(data.toString('utf8')));
    });

    await new Promise((r) => setTimeout(r, 150));
    ws2.close();

    expect(replayed.some((f) => f.type === 'conversation.assigned' && f.seq > seq1)).toBe(true);
  });
});
