# Architectural Decisions

## Architecture and Design Priorities

The application was designed with reliability, consistency, security, and recoverability as primary priorities.

- **Backend:** Node.js, Express, and TypeScript provide a modular API architecture with clear separation of responsibilities.
- **Database:** MongoDB is used for durable application data, job records, and event persistence.
- **Idempotency:** Idempotency keys prevent duplicate side effects when clients retry requests.
- **Crash Handling and Recovery:** A durable outbox and lease-based processing approach allow unfinished jobs to be retried after failures. Expired leases make abandoned work eligible for recovery, while ownership checks prevent workers from completing jobs they no longer own.
- **Concurrency Control:** Atomic database operations and conditional state transitions help prevent multiple workers from processing the same job or overwriting newer results.
- **Single-Session Management:** Redis centrally manages session state. Session ownership and validation help enforce active-session rules across application instances.
- **Redis:** Used for session management, rate limiting, and real-time coordination. A token-bucket approach controls request rates while allowing limited traffic bursts.
- **Authentication and Security:** OIDC with PKCE, secure session handling, request validation, and workspace-level authorization protect user accounts and tenant data.
- **Webhook Security:** HMAC signature verification, timestamp validation, and event deduplication help reject forged, replayed, or duplicate events.
- **Real-Time Communication:** WebSockets deliver live updates. Persisted events and replay support help clients recover updates after temporary disconnections.
- **Frontend:** React with TypeScript and Redux Toolkit manages application state. Redux Persist stores selected UI preferences, while authentication data and messages remain outside persisted Redux state.
- **Testing:** Vitest is used for test execution, React Testing Library and User Event for frontend interaction tests, and Supertest for backend API testing.

## Feature Coverage and Known Limitations

The implementation prioritizes core inbox workflows, reliability, and backend consistency. Some customer-facing features remain incomplete or require further development:

- **Email Verification:** A complete email verification workflow, including verification links, token expiry, and resend functionality, is not fully implemented.
- **Customer Management:** Customer creation is supported through the new-contact workflow, but the customer lifecycle needs further work, particularly customer removal, deletion rules, and related conversation handling.
- **Automated Support:** Automated customer support capabilities, such as AI-powered responses, automated classification, and intelligent response suggestions, are not fully implemented.
- **UI Completeness:** Some secondary UI workflows were kept minimal to prioritize the core inbox and backend reliability.

## Trade-offs and Limitations

Development focused on reliable message processing, workspace isolation, duplicate prevention, and recovery from service or worker failures. Redis is used for coordination, while MongoDB remains the durable source for persisted application records. The incomplete features above are acknowledged as areas for future development rather than being presented as completed functionality. Full assessment checks involving process-group termination require a POSIX-compatible environment such as Linux or WSL.
