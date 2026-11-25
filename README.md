# Switchboard — Shared Team Inbox

Multi-tenant shared team inbox built with **Node.js 22**, **Express**, **TypeScript**, **MongoDB**, **Redis**, **WebSockets**, and **React + Tailwind CSS**.

## Prerequisites
- Node.js `>= 22`
- Docker & Docker Compose (for MongoDB, Redis, Pigeon, Mock IdP, Paybox, and optional Elasticsearch)

## Quick Start (Clean Clone)
```bash
npm run up                 # Start MongoDB, Redis, Pigeon (:4010), Mock IdP (:4020), Paybox (:4030)
npm run doctor             # Verify all services are healthy
npm run scaffold:install   # Install server and web dependencies
```

### Run Development Servers
```bash
npm run scaffold:server    # API + WebSocket server on http://localhost:4000
npm run scaffold:web       # React UI on http://localhost:5173
```

### API Documentation (Swagger / OpenAPI)
- Swagger UI: `http://localhost:4000/docs/`
- OpenAPI 3.0 JSON: `http://localhost:4000/openapi.json`

## Tests & Checks
```bash
# Server typecheck & unit/integration/E2E tests
npm --prefix scaffold/server run typecheck
npm --prefix scaffold/server test

# Web typecheck, unit tests & production build
npm --prefix scaffold/web run typecheck
npm --prefix scaffold/web test
npm --prefix scaffold/web run build

# Official grading harness (stop dev server first)
npm run check              # Level 1
npm run check -- --levels 5
npm run check:full         # Levels 1, 2, 3, 5 (requires POSIX/Linux/WSL for SIGKILL process groups)
```

## Key Documents
- [DECISIONS.md](./DECISIONS.md) — Architecture, billing policy decisions, and known limitations.
- [PROTOCOL.md](./PROTOCOL.md) — End-to-end encrypted private notes protocol and threat model.
