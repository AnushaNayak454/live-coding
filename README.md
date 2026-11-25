# Switchboard — Shared Support Inbox

Switchboard is a multi-tenant shared customer support inbox application designed for businesses that receive real-time customer messages over messaging providers like Pigeon. Support agents log in via OpenID Connect (OIDC) with PKCE, view customer conversations, claim assignments atomically, send replies reliably, and receive real-time updates through WebSockets.

---

## Architecture Overview

```
+--------------------------------------------------------------------------------+
|                                    Clients                                     |
|                                                                                |
|  [ Support Agent Browser ]                       [ Simulated Customers ]      |
|  (React 19 + Vite Frontend)                     (Pigeon Simulator on :4010)   |
|         |                     ^                                |               |
|         | REST / OIDC         | WebSocket /ws                  | Webhook POST  |
|         v                     |                                v               |
+---------+---------------------+--------------------------------+---------------+
          |                     |                                |
          +-----------+---------+--------------------------------+
                      |
                      v
+--------------------------------------------------------------------------------+
|                           Switchboard Server Instances                         |
|                                                                                |
|  +--------------------------------------------------------------------------+  |
|  | Express Application                                                      |  |
|  |   - Auth: OIDC Authorization Code Flow with PKCE S256 + JWKS validation  |  |
|  |   - Webhooks: HMAC-SHA256 signature verification & timestamp validation  |  |
|  |   - Grader Endpoints: /__grader/* (reset, snapshot, reply, claim)        |  |
|  |   - REST API: /api/me, /api/conversations (with tenant isolation)        |  |
|  |   - WebSocket: /ws with session authentication & sequence replay         |  |
|  |   - Background Queue Worker: Token bucket rate limiter & retry worker    |  |
|  +--------------------------------------------------------------------------+  |
+---------------------+-----------------------------------+----------------------+
                      |                                   |
                      v                                   v
+-----------------------------------+   +----------------------------------------+
|             MongoDB               |   |                 Redis                  |
|  - conversations (unique tenant)  |   |  - Distributed shared sessions         |
|  - messages (deduped messageId)   |   |  - Token bucket rate limiter (8 cap,   |
|  - processedEvents (webhook dedup)|   |    4/sec refill per workspace)         |
|  - outboundJobs (durable queue)   |   |  - Atomic monotonically increasing seq |
|  - wsEvents (replayable history)  |   |  - Pub/Sub for cross-instance events   |
+-----------------------------------+   +----------------------------------------+
```

---

## Key Features

1. **OpenID Connect (OIDC) with PKCE (S256)**:
   - Authorization code flow with PKCE (`code_challenge` / `code_verifier`).
   - ID token cryptographic signature verification against provider's JWKS endpoint.
   - Nonce and state validation.
   - User identity, workspace memberships, and roles (`admin`, `agent`) extracted directly from claims.
   - Shared session storage in Redis so login sessions work seamlessly across any number of server instances.

2. **Incoming Webhook Ingestion (`POST /webhooks/pigeon`)**:
   - HMAC-SHA256 verification against the exact raw request payload.
   - Strict timestamp checking (rejects signatures older than 5 minutes with HTTP 401).
   - Timing-safe signature comparisons to prevent timing side-channel attacks.
   - Returns 400 for malformed JSON with valid signature; returns 2xx for unknown event types or unknown workspaces.
   - Deduplication using unique event IDs and atomic inserts.
   - Monotonic conversation `updatedAt` tracking to handle out-of-order message arrivals.

3. **Reliable Outbound Messaging & Queue Worker**:
   - MongoDB-backed durable queue (`outboundJobs`).
   - Idempotent reply acceptance: duplicate `client_ref` requests immediately return HTTP 202 without creating duplicate jobs.
   - Distributed locking with worker identity and lock TTLs to prevent concurrent processing across instances.
   - Distributed token-bucket rate limiter in Redis (8 burst, 4 tokens/sec refill per workspace).
   - Provider cool-off handling respects `Retry-After` headers.
   - Automatic exponential backoff for HTTP 503 failures and network timeouts.
   - Automatic recovery of abandoned jobs within 10 seconds of an instance crashing.
   - Strict status ordering (`pending` -> `sending` -> `sent` -> `delivered`/`failed`) ensures late-arriving `sent` callbacks never overwrite `delivered`.

4. **Multi-Tenant Isolation**:
   - Every workspace query enforces tenant bounds.
   - HTTP 401 returned for unauthenticated requests; HTTP 403 returned if an agent attempts to access a workspace they do not belong to.
   - WebSocket upgrade enforces the exact same tenant boundaries.

5. **Atomic Conversation Assignment**:
   - Atomic conditional updates (`findOneAndUpdate`) guarantee that if multiple agents claim the same contact simultaneously, exactly one wins while the others receive HTTP 409.
   - Current assignees claiming their own conversation receive HTTP 200.

6. **Real-Time WebSockets with Reconnect Replay**:
   - Native `ws` WebSocket server mounted at `/ws?workspace=<id>`.
   - Redis Lua script atomically generates sequence numbers and publishes frames, guaranteeing strictly increasing sequence order.
   - Durable event storage in MongoDB allows reconnecting clients (`/ws?workspace=<id>&after=<seq>`) to replay missed events seamlessly.
   - Cross-instance broadcast via Redis Pub/Sub ensures real-time updates reach connected agents regardless of which server instance processed the event.

7. **Responsive React Inbox Frontend**:
   - Modern, responsive dashboard with workspace switcher, conversation list, and interactive chat view.
   - Live delivery status indicators (queued, sent, delivered, failed).
   - One-click conversation claim, close, and reopen workflows.
   - Automatic reconnection and live status indicators.

---

## Setup & Running

### Prerequisites
- Node.js 22+
- Docker & Docker Compose (or local MongoDB on 27017 and Redis on 6379)

### 1. Start Support Services
```bash
npm run up
```
This starts MongoDB (27017), Redis (6379), and the simulators: Pigeon (4010), Mock IdP (4020), and Paybox (4030).

Verify all ports and services with:
```bash
npm run doctor
```

### 2. Install Dependencies
```bash
npm run scaffold:install
```

### 3. Run Development Server & Web App
```bash
# Terminal 1 - Server (http://localhost:4000)
npm run scaffold:server

# Terminal 2 - Web Frontend (http://localhost:5173)
npm run scaffold:web
```

---

## Running Automated Checks

The assessment check harness tests single-instance resilience, process crash recovery (`SIGKILL`), multi-instance load balancing, and real-time WebSocket isolation.

```bash
# Level 1 only (Single instance, chaos traffic, outage recovery, claim races)
npm run check

# Specific levels (e.g. Level 5 authentication & WebSocket replay)
npm run check -- --levels 5

# Full check (Levels 1, 2, 3, and 5)
npm run check:full
```

> **Note:** The check harness automatically manages server instances and loads. Stop any running dev server on port 4000 before running `npm run check`.
