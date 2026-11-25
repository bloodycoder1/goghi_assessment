import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { COLLECTIONS, closeDb, ensureIndexes, getDb } from '../src/db.js';
import { closeRedis, getRedis } from '../src/redis.js';
import { createSession } from '../src/services/auth.js';
import { indexMessageForSearch, searchWorkspaceMessages } from '../src/services/search.js';

const app = createApp();

describe('Modules 8 & 9: E2EE Private Notes & Workspace-Scoped Search', () => {
  let acmeSession = '';
  let globexSession = '';

  beforeAll(async () => {
    await getDb();
    await ensureIndexes();
    await getRedis().ping();
  });

  beforeEach(async () => {
    await request(app)
      .post('/__grader/reset')
      .set('x-grader-token', config.graderToken)
      .expect(200);

    acmeSession = await createSession({
      sub: 'u_ben',
      email: 'ben@acme.test',
      name: 'Ben Ortiz',
      workspaces: [{ id: 'ws_acme', role: 'agent' }],
    });
    globexSession = await createSession({
      sub: 'u_dev',
      email: 'dev@globex.test',
      name: 'Dev Patel',
      workspaces: [{ id: 'ws_globex', role: 'agent' }],
    });
  });

  afterAll(async () => {
    await Promise.allSettled([closeDb(), closeRedis()]);
  });

  it('stores opaque encrypted notes, blocks plaintext, and isolates notes by workspace', async () => {
    // Reject plaintext notes
    await request(app)
      .post('/api/conversations/+14155550888/notes?workspace=ws_acme')
      .set('Cookie', `sb_session=${acmeSession}`)
      .send({ plaintext: 'secret note' })
      .expect(400);

    // Register key & store wrapped workspace key envelope
    await request(app)
      .post('/api/keys/register')
      .set('Cookie', `sb_session=${acmeSession}`)
      .send({ publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' } })
      .expect(200);

    await request(app)
      .post('/api/keys/wrap?workspace=ws_acme')
      .set('Cookie', `sb_session=${acmeSession}`)
      .send({
        recipientSub: 'u_ben',
        keyVersion: 1,
        wrappedKey: 'wrapped_b64',
        ephemeralPublicKeyJwk: { kty: 'EC', crv: 'P-256', x: '111', y: '222' },
        iv: 'iv_b64',
      })
      .expect(200);

    const bundleRes = await request(app)
      .get('/api/keys/workspace?workspace=ws_acme')
      .set('Cookie', `sb_session=${acmeSession}`)
      .expect(200);
    expect(bundleRes.body.envelopes).toHaveLength(1);
    expect(bundleRes.body.envelopes[0].wrappedKey).toBe('wrapped_b64');

    // Store encrypted note
    const createRes = await request(app)
      .post('/api/conversations/+14155550888/notes?workspace=ws_acme')
      .set('Cookie', `sb_session=${acmeSession}`)
      .send({
        ciphertext: 'opaque_ciphertext_b64',
        iv: 'note_iv_b64',
        aad: 'ws_acme:+14155550888:1',
        keyVersion: 1,
      })
      .expect(201);

    expect(createRes.body.note.ciphertext).toBe('opaque_ciphertext_b64');

    // Globex agent cannot read Acme notes (403)
    await request(app)
      .get('/api/conversations/+14155550888/notes?workspace=ws_acme')
      .set('Cookie', `sb_session=${globexSession}`)
      .expect(403);

    // Acme agent can list encrypted notes
    const listRes = await request(app)
      .get('/api/conversations/+14155550888/notes?workspace=ws_acme')
      .set('Cookie', `sb_session=${acmeSession}`)
      .expect(200);
    expect(listRes.body.notes).toHaveLength(1);
    expect(listRes.body.notes[0].authorSub).toBe('u_ben');
  });

  it('indexes and searches messages via Elasticsearch with strict workspace filtering', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/_doc/')) {
        return new Response(JSON.stringify({ result: 'created' }), { status: 201 });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query?: { bool?: { filter?: Array<{ term?: Record<string, string> }> } };
      };
      expect(body.query?.bool?.filter?.[0]?.term?.['workspace.keyword']).toBe('ws_acme');
      return new Response(
        JSON.stringify({
          hits: {
            hits: [
              {
                _score: 2.5,
                _source: {
                  workspace: 'ws_acme',
                  contact: '+14155550111',
                  direction: 'inbound',
                  text: 'Need invoice copy',
                  occurredAt: new Date().toISOString(),
                },
              },
              {
                // Even if a buggy ES response returned another workspace, client filter drops it
                _score: 1.0,
                _source: {
                  workspace: 'ws_globex',
                  contact: '+14155550222',
                  direction: 'inbound',
                  text: 'Need invoice copy',
                  occurredAt: new Date().toISOString(),
                },
              },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const indexed = await indexMessageForSearch(
      {
        id: 'm1',
        workspace: 'ws_acme',
        contact: '+14155550111',
        direction: 'inbound',
        text: 'Need invoice copy',
        occurredAt: new Date(),
      },
      mockFetch as typeof fetch
    );
    expect(indexed).toBe(true);

    const res = await searchWorkspaceMessages('ws_acme', 'invoice', 10, mockFetch as typeof fetch);
    expect(res.source).toBe('elasticsearch');
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]?.workspace).toBe('ws_acme');
  });

  it('falls back to workspace-scoped MongoDB search via /api/search when ES is offline', async () => {
    await request(app)
      .post('/__grader/reply')
      .set('x-grader-token', config.graderToken)
      .send({
        workspace: 'ws_acme',
        contact: '+14155550333',
        text: 'Your refund is processed',
        client_ref: `ref_search_${crypto.randomUUID()}`,
      })
      .expect(202);

    await request(app)
      .post('/__grader/reply')
      .set('x-grader-token', config.graderToken)
      .send({
        workspace: 'ws_globex',
        contact: '+14155550444',
        text: 'Your refund is processed',
        client_ref: `ref_search_${crypto.randomUUID()}`,
      })
      .expect(202);

    const res = await request(app)
      .get('/api/search?workspace=ws_acme&q=refund')
      .set('Cookie', `sb_session=${acmeSession}`)
      .expect(200);

    expect(res.body.hits).toHaveLength(1);
    expect(res.body.hits[0].workspace).toBe('ws_acme');
    expect(res.body.hits[0].contact).toBe('+14155550333');

    // Cross-workspace search is forbidden (403)
    await request(app)
      .get('/api/search?workspace=ws_globex&q=refund')
      .set('Cookie', `sb_session=${acmeSession}`)
      .expect(403);
  });

  it('serves OpenAPI 3.0 spec at /openapi.json and Swagger UI at /docs/', async () => {
    const specRes = await request(app).get('/openapi.json').expect(200);
    expect(specRes.body.openapi).toBe('3.0.3');
    expect(specRes.body.paths['/api/conversations']).toBeDefined();
    expect(specRes.body.paths['/api/search']).toBeDefined();
    expect(specRes.body.paths['/api/conversations/{contact}/notes']).toBeDefined();

    await request(app).get('/docs/').expect(200);
  });
});
