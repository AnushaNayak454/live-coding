# Switchboard — Architectural Decisions & Post-Mortem

This document records the key architectural choices, trade-offs, and design patterns implemented for the Switchboard shared inbox platform.

---

## 1. Outbound Message Durability & Worker Design

### Context & Challenge
Outbound replies must never be lost during server crashes, network outages, or provider downtime. At the same time, customers must never receive duplicate messages, and provider rate limits (8 burst, 4/sec refill per workspace) must be respected across all running server instances.

### Decisions
- **MongoDB-Backed Queue (`outboundJobs`)**: Avoided in-memory queues (like BullMQ or in-process arrays). Every reply request (`POST /__grader/reply` and `/api/conversations/:contact/reply`) synchronously persists an `outboundJob` with a unique index on `clientRef` before returning HTTP 202.
- **Distributed Locking via Atomic `findOneAndUpdate`**: Workers poll pending jobs using atomic find-and-update with `lockedBy: WORKER_ID` and `lockedUntil: Date.now() + 10_000`. This prevents multiple server copies from processing the same job.
- **Failover & Abandoned Job Recovery**: If an instance is killed (`kill -9`), its locked jobs remain locked for at most 10 seconds. A background sweep runs every 3 seconds to unmark expired locks (`lockedUntil <= now`) back to `pending`. This recovers crashed work well within the 60-second limit.
- **Provider Outage Backoff**: During a Pigeon outage (HTTP 503), jobs back off using `[1500, 2500, 4000, 8000, 15000]` ms delays. This guarantees prompt delivery when Pigeon recovers while staying well below the threshold of 48 requests during an 8-second outage.

---

## 2. Distributed Rate Limiting & Cool-Off Synchronization

### Context & Challenge
Pigeon enforces a per-workspace bucket of 8 sends that refills at 4 sends per second. Exceeding it returns HTTP 429 with `Retry-After`. Sending requests during a cool-off window counts against the provider score. In a multi-instance deployment (Level 3), the rate limit must be enforced globally per workspace, not per server copy.

### Decisions
- **Redis Token Bucket (Atomic Lua Script)**: We implemented a token bucket in Redis using an atomic Lua script (`checkRateLimit`). It stores `tokens` and `last_refill` in a Redis Hash. It refills elapsed tokens at 4/sec up to 8 max, and atomically decrements 1 token if available.
- **Provider Cool-off (`isCoolingOff`)**: When Pigeon responds with 429, we record a cooloff key in Redis (`rl:pigeon:cooloff:<workspace>`) with a TTL equal to `Retry-After` plus a small safety margin. All server instances check this key before attempting any sends, completely eliminating sends during cooloff.

---

## 3. Webhook Signature Verification & Out-of-Order Handling

### Context & Challenge
Pigeon sends webhooks over an untrusted channel. Replayed webhooks (> 5 minutes old) and forged signatures must return HTTP 401. Messages may arrive out of order (e.g. `delivered` status before `sent`, or later messages arriving before earlier ones).

### Decisions
- **Raw Request Body Preservation**: Express's default `express.json()` alters whitespace and formatting. We implemented `rawBodyMiddleware` to capture the exact incoming `Buffer` directly from the request stream before any parsing.
- **Timing-Safe HMAC Verification**: Computed using `crypto.createHmac('sha256', secret)` and verified with `crypto.timingSafeEqual` over fixed-length buffers.
- **Monotonic Status Transitions**: In `updateMessageStatus`, we defined a strict status hierarchy (`pending: 0, sending: 1, queued: 1, sent: 2, delivered: 3, failed: 3`). MongoDB update queries enforce `status: { $in: validPriorStatuses }`. A late-arriving `sent` webhook or late HTTP 200 response will never overwrite a `delivered` status.
- **Chronological Sorting & Conversation `updatedAt`**: Inbound messages store `occurredAt`. Conversation `updatedAt` is updated only if `occurredAt > current updatedAt`, preserving correct inbox ordering even during chaotic arrival bursts.

---

## 4. Real-Time WebSockets & Monotonic Sequence Generation

### Context & Challenge
Clients receive live updates over `/ws?workspace=<id>` with a strictly increasing integer sequence number `seq`. Reconnecting clients (`/ws?workspace=<id>&after=<seq>`) must receive all missed events in exact order.

### Decisions
- **Atomic Seq Increment & Pub/Sub via Redis Lua**: If sequence generation (`INCR`) and pub/sub (`PUBLISH`) are separate asynchronous calls, race conditions between concurrent requests can cause frames to be received on the WebSocket in out-of-order sequence (`seq=2` before `seq=1`). We encapsulated the `INCR`, sequence injection, and `PUBLISH` into a single atomic Redis Lua script.
- **Durable Storage for Replay**: Every WebSocket event is persisted in MongoDB (`wsEvents` collection) with an index on `{ workspace: 1, seq: 1 }`. When a client connects with `after=<seq>`, missed events are retrieved from MongoDB, sent sequentially, and then live Redis Pub/Sub events stream continuously.

---

## 5. Authentication & Tenant Isolation

### Context & Challenge
Agents authenticate via Mock IdP using OpenID Connect Authorization Code Flow with PKCE (S256).

### Decisions
- **Strict PKCE Implementation**: High-entropy cryptographically random `code_verifier` (32 bytes) and `code_challenge` (SHA-256 base64url).
- **Cryptographic Token Verification**: ID tokens are verified using `jose.jwtVerify` against the IdP's JWKS endpoint (`/.well-known/openid-configuration` -> `jwks_uri`), validating `issuer`, `audience`, and `nonce`.
- **Shared Session Storage (`RedisSessionStore`)**: Sessions are stored in Redis (`sess:<sid>`), enabling seamless authentication across all load-balanced server instances.
- **Workspace Authorization**: Every conversation API endpoint and WebSocket upgrade inspects the session user's `workspaces` claim. Access to unauthorized workspaces is rejected with HTTP 403 (or HTTP 401 if unauthenticated).

---

## 6. What Was Cut & Known Limitations

- **Elasticsearch Search (Optional)**: Core stability, durability, crash recovery, and tenant isolation were prioritized. Search was deferred as an optional capability.
- **Paybox Billing Bonus (Optional)**: Scored as a separate optional bonus track; left out in favor of securing 100% on Levels 1, 2, 3, and 5.
- **End-to-End Encrypted Notes**: Not attempted due to strict 2-hour assessment time limit.
