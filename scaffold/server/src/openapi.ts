// OpenAPI 3.0 spec for all Switchboard APIs and expected responses.
export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Switchboard API',
    version: '1.0.0',
    description: 'Multi-tenant shared team inbox API (Pigeon webhooks, OIDC auth, E2EE notes, search, grader).',
  },
  components: {
    securitySchemes: {
      sessionCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'sb_session',
      },
      graderToken: {
        type: 'apiKey',
        in: 'header',
        name: 'x-grader-token',
      },
    },
  },
  paths: {
    '/healthz': {
      get: {
        summary: 'Health check',
        responses: {
          '200': { description: 'MongoDB and Redis are reachable' },
          '503': { description: 'Dependency unavailable' },
        },
      },
    },
    '/webhooks/pigeon': {
      post: {
        summary: 'Receive signed Pigeon inbound/status webhooks',
        responses: {
          '200': { description: 'Webhook verified and processed (or duplicate ignored)' },
          '400': { description: 'Invalid payload or unknown workspace' },
          '401': { description: 'Invalid HMAC signature or stale timestamp' },
        },
      },
    },
    '/auth/login': {
      get: {
        summary: 'Start OIDC + PKCE (S256) login flow',
        responses: {
          '302': { description: 'Redirects to IdP authorize endpoint' },
        },
      },
    },
    '/auth/callback': {
      get: {
        summary: 'OIDC callback, exchanges code and sets sb_session cookie',
        responses: {
          '302': { description: 'Redirects to web app with session cookie' },
          '400': { description: 'Missing or invalid state/code' },
        },
      },
    },
    '/auth/logout': {
      post: {
        summary: 'Clear session cookie and Redis session',
        responses: {
          '200': { description: 'Logged out' },
        },
      },
    },
    '/api/me': {
      get: {
        summary: 'Current authenticated user and workspaces',
        security: [{ sessionCookie: [] }],
        responses: {
          '200': { description: 'User profile and workspace memberships' },
          '401': { description: 'Missing or invalid session' },
        },
      },
    },
    '/api/conversations': {
      get: {
        summary: 'List workspace conversations (newest activity first)',
        security: [{ sessionCookie: [] }],
        parameters: [
          { name: 'workspace', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: {
          '200': { description: 'Paginated conversation list' },
          '400': { description: 'Missing workspace parameter' },
          '401': { description: 'Unauthorized' },
          '403': { description: 'Forbidden: not a workspace member' },
          '404': { description: 'Unknown workspace' },
        },
      },
    },
    '/api/conversations/{contact}/messages': {
      get: {
        summary: 'Ordered message history for a contact',
        security: [{ sessionCookie: [] }],
        parameters: [
          { name: 'contact', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workspace', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Ordered messages array' },
          '401': { description: 'Unauthorized' },
          '403': { description: 'Forbidden' },
        },
      },
    },
    '/api/conversations/{contact}/claim': {
      post: {
        summary: 'Atomically claim a conversation for the current agent',
        security: [{ sessionCookie: [] }],
        parameters: [
          { name: 'contact', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workspace', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Claimed (or already held by same agent)' },
          '401': { description: 'Unauthorized' },
          '403': { description: 'Forbidden' },
          '409': { description: 'Already claimed by another agent' },
        },
      },
    },
    '/api/conversations/{contact}/status': {
      post: {
        summary: 'Open or close a conversation',
        security: [{ sessionCookie: [] }],
        parameters: [
          { name: 'contact', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workspace', in: 'query', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status'],
                properties: { status: { type: 'string', enum: ['open', 'closed'] } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Status updated' },
          '400': { description: 'Invalid status' },
          '401': { description: 'Unauthorized' },
          '403': { description: 'Forbidden' },
          '404': { description: 'Conversation not found' },
        },
      },
    },
    '/api/conversations/{contact}/reply': {
      post: {
        summary: 'Enqueue an outbound reply via durable outbox',
        security: [{ sessionCookie: [] }],
        parameters: [
          { name: 'contact', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workspace', in: 'query', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['text'],
                properties: {
                  text: { type: 'string' },
                  client_ref: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '202': { description: 'Reply queued in outbox' },
          '400': { description: 'Missing text' },
          '401': { description: 'Unauthorized' },
          '403': { description: 'Forbidden' },
        },
      },
    },
    '/api/keys/register': {
      post: {
        summary: 'Register agent ECDH P-256 public key (JWK)',
        security: [{ sessionCookie: [] }],
        responses: {
          '200': { description: 'Public key saved' },
          '400': { description: 'Missing publicKeyJwk' },
          '401': { description: 'Unauthorized' },
        },
      },
    },
    '/api/keys/workspace': {
      get: {
        summary: 'Fetch wrapped workspace key envelopes and member public keys',
        security: [{ sessionCookie: [] }],
        parameters: [{ name: 'workspace', in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Wrapped key envelopes and public keys' },
          '401': { description: 'Unauthorized' },
          '403': { description: 'Forbidden' },
        },
      },
    },
    '/api/keys/wrap': {
      post: {
        summary: 'Store a wrapped workspace key envelope for a recipient agent',
        security: [{ sessionCookie: [] }],
        parameters: [{ name: 'workspace', in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Envelope stored' },
          '400': { description: 'Invalid envelope' },
          '401': { description: 'Unauthorized' },
          '403': { description: 'Forbidden' },
        },
      },
    },
    '/api/conversations/{contact}/notes': {
      get: {
        summary: 'List opaque E2EE private notes for a conversation',
        security: [{ sessionCookie: [] }],
        parameters: [
          { name: 'contact', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workspace', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Encrypted notes array' },
          '401': { description: 'Unauthorized' },
          '403': { description: 'Forbidden' },
        },
      },
      post: {
        summary: 'Store a client-encrypted private note (plaintext rejected)',
        security: [{ sessionCookie: [] }],
        parameters: [
          { name: 'contact', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workspace', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '201': { description: 'Encrypted note stored' },
          '400': { description: 'Plaintext rejected or missing ciphertext fields' },
          '401': { description: 'Unauthorized' },
          '403': { description: 'Forbidden' },
        },
      },
    },
    '/api/search': {
      get: {
        summary: 'Workspace-scoped message search (Elasticsearch with MongoDB fallback)',
        security: [{ sessionCookie: [] }],
        parameters: [
          { name: 'workspace', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 25 } },
        ],
        responses: {
          '200': { description: 'Matching workspace-scoped hits' },
          '401': { description: 'Unauthorized' },
          '403': { description: 'Forbidden' },
        },
      },
    },
    '/__grader/reset': {
      post: {
        summary: 'Reset all application data (grader only)',
        security: [{ graderToken: [] }],
        responses: {
          '200': { description: 'Application data cleared' },
          '401': { description: 'Invalid x-grader-token' },
        },
      },
    },
    '/__grader/snapshot': {
      get: {
        summary: 'Return system snapshot for grading',
        security: [{ graderToken: [] }],
        responses: {
          '200': { description: 'Workspace contacts and outbound status snapshot' },
          '401': { description: 'Invalid x-grader-token' },
        },
      },
    },
    '/__grader/reply': {
      post: {
        summary: 'Enqueue a reply as if an agent sent it (grader only)',
        security: [{ graderToken: [] }],
        responses: {
          '202': { description: 'Reply queued' },
          '400': { description: 'Missing required fields' },
          '401': { description: 'Invalid x-grader-token' },
          '404': { description: 'Unknown workspace' },
        },
      },
    },
    '/__grader/claim': {
      post: {
        summary: 'Atomically claim a conversation as an agent (grader only)',
        security: [{ graderToken: [] }],
        responses: {
          '200': { description: 'Claimed' },
          '400': { description: 'Missing required fields' },
          '401': { description: 'Invalid x-grader-token' },
          '404': { description: 'Unknown workspace' },
          '409': { description: 'Already claimed by another agent' },
        },
      },
    },
    '/webhooks/paybox': {
      post: {
        summary: 'Receive signed Paybox billing webhooks',
        responses: {
          '200': { description: 'Webhook verified and subscription synced' },
          '400': { description: 'Malformed payload' },
          '401': { description: 'Invalid HMAC signature or stale timestamp' },
        },
      },
    },
    '/api/billing': {
      get: {
        summary: 'Get workspace billing state (admin only)',
        security: [{ sessionCookie: [] }],
        parameters: [{ name: 'workspace', in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Billing status, seats, can_send, nextActionUrl' },
          '401': { description: 'Unauthorized' },
          '403': { description: 'Forbidden: admin role required' },
        },
      },
    },
    '/api/billing/subscribe': {
      post: {
        summary: 'Subscribe workspace using client-side Paybox card token (admin only)',
        security: [{ sessionCookie: [] }],
        responses: {
          '200': { description: 'Subscription active' },
          '402': { description: 'Payment failed or requires bank action' },
          '403': { description: 'Forbidden: admin role required' },
        },
      },
    },
    '/api/billing/seats': {
      post: {
        summary: 'Update workspace seat count (admin only)',
        security: [{ sessionCookie: [] }],
        responses: {
          '200': { description: 'Seats updated' },
          '402': { description: 'Seat increase charge failed' },
          '403': { description: 'Forbidden: admin role required' },
        },
      },
    },
    '/__grader/billing/subscribe': {
      post: {
        summary: 'Subscribe workspace with card token (grader only)',
        security: [{ graderToken: [] }],
        responses: {
          '200': { description: 'Subscription active' },
          '402': { description: 'Subscription not active' },
        },
      },
    },
    '/__grader/billing/seats': {
      post: {
        summary: 'Change workspace seats (grader only)',
        security: [{ graderToken: [] }],
        responses: {
          '200': { description: 'Seats updated' },
          '402': { description: 'Seat change failed' },
        },
      },
    },
  },
};
