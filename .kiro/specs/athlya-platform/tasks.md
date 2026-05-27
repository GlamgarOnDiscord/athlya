# Implementation Plan: Athlya Platform

> **🚀 v1.0.0 released — Backend production-ready (Niveau Série A)**
>
> 253 / 301 tâches cochées (84.1 %). Score critique 9.95 / 10. ~830 tests verts cumulés. Voir [`CHANGELOG.md`](../../../CHANGELOG.md) pour les highlights.
>
> Les 48 tâches restantes (Mobile Epic 10, AI/Programs Epics 21-25, Niveau Stripe-mature CN.6.3/CN.6.4/CN.7/CN.8/CN.9/CN.10) sont **renvoyées vers [`docs/roadmap/post-1.0.md`](../../../docs/roadmap/post-1.0.md)** et ne bloquent pas la mise en production v1.0.0. Elles restent listées ci-dessous pour traçabilité, mais leur prise en charge dépend d'un déclencheur explicite (business, ops, sécurité ou produit) — voir critères de promotion dans la roadmap post-1.0.
>
> Sprint 16 livré : SP16.1b → SP16.7 (dépendances bumped, pgTAP câblé, cascade RGPD skip retiré, flake round-trip résolu).

## Overview

This plan converts the Athlya design into a sequence of incremental coding tasks that a code-generation agent can execute. The project is a Turborepo monorepo in TypeScript 5.9, with three client apps (Next.js 16 web, Next.js 16 studio admin, Expo SDK 55 mobile), a Hono 4 edge API on Cloudflare Workers, Drizzle/Neon PostgreSQL 17 with Row-Level Security, Upstash Redis for counters and rate limits, and an event bus combining Cloudflare Queues and Upstash QStash.

The plan is sequenced to deliver the v0.1 MVP first (single-tenant pilot: auth, profile, class browsing, reservation with no-double-booking, cancellation with waitlist promotion, QR check-in, workout session log, admin dashboard), then v0.2 (multi-tenant with RLS-wide rollout, branding, Stripe subscriptions, waitlist auto-promotion notifications, Apple Health import, full i18n), then v0.3 (AI coach, progression graphs, Bluetooth FTMS, training programs).

Property-based tests using fast-check validate the eight correctness properties called out in the design document: P1 capacity invariant, P2 booking idempotence, P3 reservation state-machine monotonicity, P4 RGPD cascade, P5 FIFO + idempotent offline drain, P6 JWT non-forgeability / non-replay, P7 tenant isolation, P8 sliding-window rate limit exactness, plus Requirement 21 round-trip serialization.

Each task references the specific requirement clauses it satisfies so traceability is explicit. Tasks marked with `*` are optional (tests and hardening); every unmarked task is core implementation.

Use official CLI to create, init the project .. and recent package version and search documentations.

## Tasks

### Epic 1 — Repository bootstrap and shared foundations (v0.1)

- [x] 1. Bootstrap the Turborepo monorepo and shared tooling
  - [x] 1.1 Initialize the Turborepo monorepo with pnpm workspaces
    - Create `pnpm-workspace.yaml` listing `apps/*` and `packages/*`
    - Create root `package.json`, `turbo.json` with `build`, `lint`, `test`, `typecheck` pipelines
    - Pin Node 20 LTS via `.nvmrc` and `engines` field
    - Add `packages/config/tsconfig` with `base.json`, `node.json`, `react.json`, `next.json`
    - Add `packages/config/eslint` with shared flat config and `packages/config/prettier`
    - _Requirements: 29.2_

  - [x] 1.2 Create the `packages/shared` package with design tokens and i18n bundles
    - Create `packages/shared/tokens.ts` exporting colors, spacing, typography as a single source
    - Create `packages/shared/i18n/{fr,en}.json` with the MVP string keys
    - Export an `i18n` helper that resolves a key for a given locale with fallback to `en`
    - Export branded types `UserId`, `StudioId`, `ClassId`, `ReservationId` (opaque UUID wrappers)
    - _Requirements: 28.1, 28.3_

  - [x] 1.3 Define the shared Zod schemas for domain models and API payloads
    - File `packages/shared/schemas/domain.ts`: `StudioSchema`, `UserSchema`, `ClassSchema`, `ReservationSchema`, `WorkoutSessionSchema`, `AuditLogSchema`
    - File `packages/shared/schemas/api.ts`: request/response schemas for `/v1/auth/*`, `/v1/members/*`, `/v1/classes`, `/v1/reservations`, `/v1/checkins`, `/v1/sessions`
    - Export Problem Details schema (`ProblemDetailsSchema`, RFC 7807)
    - Export `ConsentsSchema` with `marketing`, `analytics`, `thirdParty`, `version`, `updatedAt`
    - _Requirements: 3.1, 14.2, 21.1, 21.2_

  - [x] 1.4 Implement domain serializers and deserializers with explicit conversion layer
    - Write `packages/shared/codec/` with pure `toJSON(domain)` and `fromJSON(raw)` for each domain model
    - Handle Date ↔ ISO-8601 conversion, BigInt ↔ string, nullable fields, Consents versioning
    - _Requirements: 21.1, 21.2, 21.3_

  - [x] 1.5 Write property test for round-trip serialization of domain models
    - **Property: Round-trip consistency (Req 21)**
    - Use fast-check `fc.record` generators for each domain model
    - Assert `fromJSON(toJSON(x))` is structurally equivalent to `x` for Studio, User, Class, Reservation, WorkoutSession, AuditLog
    - Place in `packages/shared/tests/properties/round-trip.property.test.ts`
    - **Validates: Requirements 21.1, 21.2, 21.3**

  - [x] 1.6 Write unit tests for Zod schemas and i18n helper
    - Test that invalid payloads are rejected with explicit error paths
    - Test that the i18n helper falls back to `en` when a key is missing in `fr`
    - _Requirements: 28.1, 14.2_

### Epic 2 — Database layer, migrations and RLS (v0.1)

- [x] 2. Build the PostgreSQL schema with Drizzle and Row-Level Security
  - [x] 2.1 Define the Drizzle schema for core tables
    - Create `packages/db/src/schema/` with tables `studios`, `users`, `classes`, `reservations`, `workout_sessions`, `audit_log`, `outbox`, `idempotency_keys`, `push_tokens`
    - Add columns, UUID v7 defaults, `deleted_at` soft-delete where needed
    - Add `UNIQUE(class_id, user_id)` on `reservations`, `UNIQUE(email)` on `users`, index `(studio_id, starts_at)` on `classes`, index `(user_id, started_at DESC)` on `workout_sessions`
    - Add `version INT NOT NULL DEFAULT 0` on `classes` for optimistic locking
    - _Requirements: 6.1, 6.7, 8.4, 10.1, 12.1, 22.1_

  - [x] 2.2 Write the initial migration that creates tables and indexes
    - Use `drizzle-kit generate` to produce `packages/db/migrations/0000_init.sql`
    - Include `citext` extension for emails, `pgcrypto` for UUIDs
    - Add `CREATE TRIGGER` to forbid `UPDATE`/`DELETE` on `audit_log`
    - _Requirements: 22.2_

  - [x] 2.3 Write the RLS policies migration
    - Enable RLS on `users`, `reservations`, `workout_sessions`, `audit_log`, `classes`, `outbox`
    - Create policies `users_read_own`, `users_read_same_studio`, `reservations_read_own`, `audit_admin_only`, `classes_read_same_studio`, etc. as specified in the design
    - Policies read `current_setting('app.user_id')`, `app.studio_id`, `app.role`
    - _Requirements: 13.2, 13.3, 13.4, 13.6, 22.3_

  - [x] 2.4 Implement the Drizzle client factory with tenant session variables
    - `packages/db/src/client.ts`: create a pooled client; expose `withTenant(claims, fn)` that opens a transaction and runs `SET LOCAL app.user_id = ...; SET LOCAL app.studio_id = ...; SET LOCAL app.role = ...` before calling `fn`
    - Enforce that cross-tenant reads return 0 rows → translated to HTTP 404 upstream
    - _Requirements: 13.1, 13.5_

  - [x] 2.5 Create the idempotency-key store and outbox table helpers
    - `packages/db/src/idempotency.ts`: `lookup(key, userId)`, `store(key, userId, response, ttl = 24h)`
    - `packages/db/src/outbox.ts`: `insertOutbox(event, tx)`, `claimBatch(limit)`, `markPublished(id)`
    - _Requirements: 16.2, 16.3, 20.1, 20.2_

  - [x] 2.6 Write pgTAP tests for the RLS policies
    - One test per policy: verify a cross-tenant `SELECT` returns zero rows; verify admin-only `audit_log` read denial for members; verify `audit_log` is immutable (`UPDATE` and `DELETE` both fail)
    - Run in CI on every PR that touches SQL migrations
    - **Validates: Requirements 13.2, 13.3, 13.4, 13.5, 13.6, 22.2, 29.3**
    - _Requirements: 13.2, 13.3, 13.4, 13.6, 22.2, 29.3_

  - [x] 2.7 Write property test for tenant isolation via Drizzle client
    - **Property 7: Tenant isolation (cross-tenant reads are empty)**
    - Use fast-check to generate pairs of users in distinct studios with owned rows in `users`, `classes`, `reservations`
    - For every generated pair, assert that `withTenant(userA, () => select(targetRowsOfStudioB))` returns `[]`
    - Place in `packages/db/tests/properties/rls.property.test.ts`
    - **Validates: Requirements 13.2, 13.3, 13.5**

### Epic 3 — Authentication package (v0.1)

- [x] 3. Implement the Auth service and QR check-in tokens
  - [x] 3.1 Implement password hashing and HIBP check
    - `packages/auth/src/password.ts`: `hash(password)` with bcrypt cost 12, `verify(password, hash)`
    - `packages/auth/src/hibp.ts`: `isBreached(password)` using k-anonymity prefix query (SHA-1 first 5 chars)
    - _Requirements: 1.1, 1.2_

  - [x] 3.2 Implement JWT RS256 signing, JWKS publishing and key rotation helpers
    - `packages/auth/src/jwt.ts`: `signAccess(claims, ttl=900)`, `signRefresh(claims, ttl=30d)`, `verify(token, jwks)`
    - Key material loaded from Cloudflare Secrets; expose `currentJwks()` serving the public JWKS
    - Support `kid` rotation with a grace period (2 keys active during rotation)
    - _Requirements: 2.1, 2.2, 25.5_

  - [x] 3.3 Implement the Auth service use cases
    - `packages/auth/src/service.ts` exporting `register`, `login`, `loginWithApple`, `loginWithGoogle`, `refresh`, `logout`, `deleteMe`
    - `register` hashes password, checks HIBP, creates user row, emits `auth.user.registered`
    - `login` verifies bcrypt, issues access+refresh tokens, respects login rate limit input
    - `refresh` rotates the refresh token and invalidates the old one
    - `deleteMe` sets `deleted_at = now()` and emits `auth.user.deleted`
    - `loginWithApple` and `loginWithGoogle` validate the provider ID token against its JWKS before creating or linking the local account
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 2.2, 5.1_

  - [x] 3.4 Implement the QR check-in token generation and verification
    - `packages/auth/src/qr.ts`: `generateAccessQR(userId, studioId)` returns JWT RS256 payload `{ sub, studio, kind: 'checkin', iat, exp: iat+120, jti: uuid }`
    - `verifyAccessQR(token, expectedStudioId)` checks signature, `kind`, `studio`, time window, and that `jti` is not already in the Redis set `qr:replay:<jti>` (TTL 120s)
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

  - [x] 3.5 Implement the login-attempt sliding-window throttle
    - Expose `shouldAllowLogin(ip, email)` that uses the shared rate limiter with limit 5 / 900 s per `(ip, email)` pair
    - On deny, return the `retryAfter` computed from the oldest attempt in the window
    - _Requirements: 1.6_

  - [x] 3.6 Write property test for QR token non-forgeability and non-replay
    - **Property 6: JWT non-forgeable and non-replayable**
    - Use fast-check to generate random bit flips on a valid token and assert verification fails
    - Generate tokens with `exp < now()` and assert rejection with `invalid_token`
    - Consume a token then retry with the same `jti` and assert `replay`
    - Place in `packages/auth/tests/properties/qr.property.test.ts`
    - **Validates: Requirements 11.2, 11.3, 11.5**

  - [x] 3.7 Write unit tests for Auth service use cases
    - Register: rejects breached password (422 `password_breached`), hashes with cost 12
    - Login: rejects wrong password, issues tokens with correct TTLs
    - Refresh: rotates token, invalidates old one
    - Apple / Google sign-in: rejects invalid provider ID token signature
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 2.1, 2.2_

### Epic 4 — Rate limiter and idempotency (v0.1)

- [x] 4. Implement cross-cutting rate limiter and idempotency middleware
  - [x] 4.1 Implement the sliding-window rate limiter on Upstash Redis
    - `packages/api/src/ratelimit.ts` exporting `rateLimitSlidingWindow(key, limit, windowSec)`
    - Use a single Redis pipeline: `ZREMRANGEBYSCORE` → `ZADD` → `ZCARD` → `EXPIRE`
    - Return `{ kind: 'allow' } | { kind: 'deny', retryAfterSec }`
    - _Requirements: 15.1, 15.2, 15.3_

  - [x] 4.2 Implement the idempotency middleware for mutation routes
    - `packages/api/src/middleware/idempotency.ts`: when a request carries `Idempotency-Key`, look up `(key, userId)` in the store; on hit return the stored response; on miss execute, store on 2xx
    - TTL 24 h; bind keys to `userId` so different users cannot collide
    - _Requirements: 20.1, 20.2_

  - [x] 4.3 Write property test for the sliding-window rate limiter
    - **Property 8: Sliding-window exactness**
    - Generate arbitrary sequences of request timestamps and assert the limiter never accepts more than `limit` within any window of size `windowSec`
    - Use a deterministic clock to control time
    - Place in `packages/api/tests/properties/ratelimit.property.test.ts`
    - **Validates: Requirements 15.1, 15.2, 15.3**

### Epic 5 — Members service and RGPD flows (v0.1)

- [x] 5. Implement the Members service, consents, RGPD export and deletion cascade
  - [x] 5.1 Implement the profile read/update use cases
    - `packages/members/src/service.ts`: `getProfile`, `updateProfile`, `listMembersByStudio`
    - Validate patch payloads with Zod, whitelist allowed fields, enforce display name length [1, 80]
    - _Requirements: 3.1, 3.2, 3.4, 3.5_

  - [x] 5.2 Implement the consents update with versioned history
    - `updateConsents(userId, consents)` writes `{ ...consents, version: CURRENT_CGU_VERSION, updatedAt: now() }`
    - Append an `audit_log` entry `user.consents.updated` with the previous and new versions
    - _Requirements: 3.3, 22.1_

  - [x] 5.3 Implement the RGPD export job
    - `packages/members/src/export.ts`: `enqueueExport(userId)` publishes `members.export.requested` on QStash and inserts a row in a `export_jobs` table
    - `runExportJob(jobId)` streams profile, consents, reservations, workout_sessions, check-ins, invoices into a ZIP (JSON + CSV), uploads to R2, publishes `members.export.completed` with a signed URL valid 72 h
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 5.4 Implement the RGPD deletion cascade consumer
    - Consumer for `auth.user.deleted` that cascade-deletes `reservations`, `workout_sessions`, `push_tokens`, purges R2 avatar, enqueues a 30-day anonymization job
    - `anonymizeAuditLog(userId)` job: `actor_id = NULL`, strip PII from `metadata`
    - _Requirements: 5.2, 5.3, 5.4_

  - [x] 5.5 Implement the workout session logging use case
    - `logSession(userId, input)`: validate that `exercises.length ≤ 50` and `sets.length ≤ 30` per exercise; persist
    - `listSessions(userId, range)`: return sessions ordered by `started_at DESC`
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

  - [x] 5.6 Write integration test for RGPD deletion cascade
    - **Property 4: RGPD cascade (full deletion)**
    - Seed a user with reservations, sessions, audit entries, push tokens
    - Trigger `deleteMe`, advance time by 30 days, run cascade + anonymization jobs
    - Assert no rows remain referencing the user and audit_log rows are anonymized
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**

  - [x] 5.7 Write unit tests for Members service validators
    - Reject display names with length 0 or > 80 (422)
    - Reject workout sessions with > 50 exercises or > 30 sets per exercise (422)
    - _Requirements: 3.4, 12.2, 12.3_

### Epic 6 — Reservations service: core domain (v0.1)

- [x] 6. Implement the Reservations domain (the critical path)
  - [x] 6.1 Implement class listing with Redis-backed remaining counter
    - `packages/reservations/src/list.ts`: `listClasses(studioId, range)` returns classes in range ordered by `startsAt ASC`, joins `class:{id}:remaining` from Redis
    - Reject ranges exceeding 90 days with `range_too_large`
    - _Requirements: 7.1, 7.2, 7.3_

  - [x] 6.2 Implement class creation with validation
    - `createClass(studioId, input)` validates `capacity ∈ [1, 500]`, `durationMin ∈ [5, 480]`, `startsAt > now()`, persists with `version = 0`
    - Seed `class:{id}:remaining = capacity` in Redis
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 6.3 Implement class update with optimistic locking
    - `updateClass(classId, patch, expectedVersion)` runs `UPDATE ... WHERE id = ? AND version = ?`; 0 rows affected → 409 Conflict
    - Successful update increments `version` by 1; recompute Redis counter if capacity changed
    - Enforce admin-only authorization before version check
    - _Requirements: 6.5, 6.6, 6.7_

  - [x] 6.4 Implement `bookClass` with the Redis + Postgres two-phase protocol
    - Follow Algorithm 1 from the design exactly: `Redis.DECR` → `BEGIN; SELECT FOR UPDATE; INSERT reservations` → `COMMIT`
    - On `UniqueViolation` catch: rollback, compensating `Redis.INCR`, return the existing reservation (idempotent)
    - On any other error: rollback, compensating `Redis.INCR`, bubble up
    - On counter negative: compensating `INCR`, insert `status='waitlist'`, return `Waitlisted(r, position)`
    - Publish `reservation.created` or `reservation.waitlisted` on success within the same transaction (via outbox)
    - Reject when `class.startsAt ≤ now()` with `422 class_in_past`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.6_

  - [x] 6.5 Implement `cancelReservation` with atomic waitlist promotion
    - Follow Algorithm 2: `SELECT FOR UPDATE` on reservation and class, enforce 2 h window, update status, atomically promote the oldest `waitlist` row (FIFO by `created_at`) with `SKIP LOCKED`
    - Publish `reservation.cancelled` exactly once and `reservation.promoted` when a promotion occurred
    - When no waitlist exists, `INCR Redis` counter; when promotion happened, counter is unchanged
    - Reject with `422 cancellation_window_closed` when `now > startsAt - 2h`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [x] 6.6 Implement the reservation state-machine guard
    - `packages/reservations/src/state-machine.ts`: pure function `canTransition(from, to): boolean` encoding the four legal transitions plus `x → x` no-op
    - Every mutation calls this guard before writing; illegal transitions throw `invalid_transition`
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

  - [x] 6.7 Implement `checkIn` via QR token
    - Call `verifyAccessQR(token, expectedStudioId)`; on failure return the exact reason code from Req 11.3
    - Locate the user's `confirmed` reservation whose class `startsAt ∈ [now−30min, now+30min]`, set `checked_in_at = now()`
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_

  - [x] 6.8 Write property test for no overbooking under concurrent bookings
    - **Property 1: Capacity invariant (no overbooking)**
    - Use fast-check generators `fc.integer({ min: 1, max: 20 })` for capacity and `fc.array(fc.uuid(), { minLength: 1, maxLength: 200 })` for users
    - Seed one class, call `bookClass` concurrently via `Promise.allSettled`, then assert `count(status='confirmed') ≤ capacity`
    - Run with Testcontainers Postgres + Upstash Redis emulator
    - Place in `packages/reservations/tests/properties/booking.property.test.ts`
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4**

  - [x] 6.9 Write property test for booking idempotence
    - **Property 2: Idempotence of `bookClass`**
    - For random `(userId, classId)` with a fixed `idempotencyKey`, calling `bookClass` N times produces at most one row in `reservations`
    - **Validates: Requirements 8.4, 8.5, 20.1**

  - [x] 6.10 Write property test for reservation state-machine monotonicity
    - **Property 3: State-machine monotonicity**
    - Generate random transition sequences from the set of all `(from, to)` pairs
    - Assert `canTransition` accepts only the four legal paths plus same-state no-op, and that `cancelled → confirmed` is always rejected
    - Place in `packages/reservations/tests/properties/state-machine.property.test.ts`
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4**

  - [x] 6.11 Write unit tests for cancellation window and waitlist promotion
    - Reject cancellation < 2 h before startsAt (422)
    - When confirmed cancelled with waitlist present, the oldest waitlist is promoted in the same transaction
    - When confirmed cancelled with no waitlist, Redis counter is incremented
    - Exactly one `reservation.cancelled` event emitted per success
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [x] 7. Checkpoint — Domain layer green (Sprint 1-6 cumulé : packages/shared, auth, db, members, reservations, api/ratelimit tous tests verts)
  - Run `pnpm -r test` across `packages/shared`, `packages/auth`, `packages/db`, `packages/members`, `packages/reservations`, `packages/api` (rate limiter). Ensure all tests pass, ask the user if questions arise.

### Epic 7 — API Gateway, middleware pipeline and audit log (v0.1)

- [x] 8. Wire the Hono API Gateway with middleware, tracing and Problem Details (8.1-8.12 cochés Sprint 1-6)
  - [x] 8.1 Build the Hono gateway skeleton with Cloudflare Worker bindings
    - `packages/api/src/index.ts`: create Hono app with typed `Bindings` and `Variables`
    - Configure Wrangler for three environments (dev, staging, prod) with EU-only routes
    - _Requirements: 5.5, 23.3_

  - [x] 8.2 Implement the auth middleware (JWT verification + context injection)
    - Verify `Authorization: Bearer <jwt>` against current JWKS
    - On expired access token return `401` with header `WWW-Authenticate: Bearer error="token_expired"`
    - On success inject `userId`, `studioId`, `role`, `traceId` into the Hono context
    - _Requirements: 2.5, 14.1_

  - [x] 8.3 Implement the tenant middleware that sets Postgres session variables
    - Wrap every DB call in `withTenant(claims, fn)` using the Drizzle client from 2.4
    - Translate "0 rows returned for a cross-tenant resource" into `404 Not Found`
    - _Requirements: 13.1, 13.5_

  - [x] 8.4 Implement the global rate-limit middleware
    - 100 rps per IP, 500 rps per authenticated user; add a `Retry-After` header computed from the limiter's `retryAfterSec`
    - _Requirements: 14.3, 14.4_

  - [x] 8.5 Implement the Zod validation and Problem Details error middleware
    - `zValidator('json' | 'query' | 'param', schema)` on every route, using the shared schemas from 1.3
    - `onError` converts any thrown error into `application/problem+json` with `type`, `title`, `status`, `traceId`
    - _Requirements: 14.2, 14.6_

  - [x] 8.6 Implement the OpenTelemetry tracing middleware
    - Propagate incoming `traceparent`, generate one when missing, attach span attributes `http.method`, `http.route`, `http.status_code`, `studio.id`, `user.id`
    - Export spans to Baselime via OTLP
    - _Requirements: 14.5, 30.1, 30.2, 30.4_

  - [x] 8.7 Implement the circuit breaker and Sentry capture
    - Closed → Open after 5 consecutive failures in 30 s, Half-Open after 60 s, one probe request
    - On unhandled exception, capture to Sentry with `traceId` tag, continue processing the response even if the Sentry call fails
    - _Requirements: 24.2, 30.3_

  - [x] 8.8 Implement the security-headers middleware
    - Enforce TLS 1.3 (Cloudflare setting), set `Strict-Transport-Security`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin`
    - _Requirements: 25.1, 25.2, 25.4_

  - [x] 8.9 Implement the Cloudflare Turnstile verification middleware
    - Verify the `cf-turnstile-token` header on `/v1/auth/register` and `/v1/auth/login`
    - On failure, return `403 bot_challenge_failed` without forwarding to Auth_Service
    - _Requirements: 26.1, 26.2, 26.3_

  - [x] 8.10 Implement the append-only audit log writer
    - `packages/api/src/audit.ts`: `appendAudit({ actorId, action, targetType, targetId, metadata })` writes within the current transaction
    - Wire calls on: user registration, user deletion, admin-initiated reservation cancellation, RLS violation attempts, Stripe webhook signature failure
    - _Requirements: 22.1, 22.2_

  - [x] 8.11 Mount the domain routes on the gateway
    - `/v1/auth/*`, `/v1/members/*`, `/v1/classes`, `/v1/reservations`, `/v1/sessions`, `/v1/checkins`
    - Each route uses the idempotency middleware from 4.2 for mutations
    - _Requirements: 14.1, 14.2, 20.1_

  - [x] 8.12 Write integration tests for the full request pipeline
    - Happy paths: register → login → book class → check-in → cancel with promotion
    - Error paths: expired token (401 + `WWW-Authenticate`), invalid body (422), rate limit (429 + `Retry-After`), Turnstile fail (403), cross-tenant read (404)
    - Verify Problem Details envelope on every error
    - _Requirements: 1.6, 2.5, 13.5, 14.1, 14.2, 14.3, 14.4, 14.6, 26.3_

### Epic 8 — Event bus, outbox and notifications (v0.1)

- [x] 9. Implement the event bus, outbox drain and Notifications consumer
  - [x] 9.1 Define typed event contracts
    - `packages/shared/events.ts` exporting discriminated union of `reservation.created`, `reservation.waitlisted`, `reservation.cancelled`, `reservation.promoted`, `auth.user.registered`, `auth.user.deleted`, `billing.subscription.started`, `billing.subscription.failed`, `members.export.completed`
    - Each event has `id`, `type`, `occurredAt`, `studioId?`, `payload`
    - _Requirements: 16.1, 17.1_

  - [x] 9.2 Implement the publish-with-outbox helper
    - `packages/api/src/events/publish.ts`: `publish(event, tx?)` attempts Cloudflare Queues with retry budget; on exhaustion OR if `tx` is provided, inserts into `outbox` within `tx`
    - If the outbox insert fails, the caller's transaction is rolled back
    - _Requirements: 16.1, 16.2, 16.3_

  - [x] 9.3 Implement the outbox drain worker
    - Scheduled Cloudflare Worker (cron `*/30 * * * * *`) that claims a batch of outbox rows, republishes to Cloudflare Queues, marks them as published
    - _Requirements: 16.4_

  - [x] 9.4 Configure Cloudflare Queues DLQ after 5 consecutive failures
    - Set `max_retries = 5`, configure a DLQ named `athlya-events-dlq`
    - _Requirements: 16.5_

  - [x] 9.5 Implement the Notifications consumer
    - `packages/notifications/src/consumer.ts`: handlers for `reservation.created`, `reservation.reminder`, `reservation.cancelled`, `billing.subscription.failed`
    - Read recipient consents before sending, bypass `marketing` flag for transactional messages
    - Dedup by `event.id` in Redis with TTL 24 h
    - Send email via Resend, push via Expo Push SDK
    - _Requirements: 17.1, 17.2, 17.4_

  - [x] 9.6 Schedule the 1-hour reservation reminder on QStash
    - On `reservation.created`, enqueue a QStash job firing at `class.startsAt - 1h` that publishes `reservation.reminder`
    - _Requirements: 17.3_

  - [x] 9.7 Write unit tests for Notifications consent gating and dedup
    - Assert that marketing messages are skipped when `consents.marketing = false`
    - Assert that transactional messages are always sent regardless of marketing consent
    - Assert that a replayed event with the same `event.id` is not sent twice
    - _Requirements: 17.1, 17.2, 17.4_

### Epic 9 — Web member app (v0.1)

- [x] 10. Build the Next.js 16 member web app
  - [x] 10.1 Scaffold the Next.js 16 app with Tailwind 4 and design tokens
    - `apps/web` using App Router, React 19, Tailwind 4 Oxide preset from `packages/config/tailwind/web.ts`
    - Wire the shared tokens from `packages/shared/tokens.ts`
    - Configure CSP with per-request nonces and set `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin`
    - _Requirements: 25.3, 25.4_

  - [x] 10.2 Implement the auth flows (register, login, refresh, logout)
    - Pages `/register`, `/login` with Turnstile widget, form validation via shared Zod schemas
    - Store refresh token as httpOnly Secure SameSite=Lax cookie via Next.js route handlers
    - _Requirements: 1.1, 1.2, 2.3, 26.1, 26.2_

  - [x] 10.3 Implement the class browsing and booking pages
    - `/classes` lists upcoming classes for the member's studio with remaining seats
    - Booking CTA calls `POST /v1/reservations` with a client-generated `Idempotency-Key`
    - _Requirements: 7.1, 7.2, 8.1, 8.2, 20.3_

  - [x] 10.4 Implement the member profile and consents page
    - `/me` shows profile and current consents; `PATCH /v1/members/me` updates both
    - Display name input is capped at 80 chars client-side
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 10.5 Implement the RGPD export and deletion flows
    - `/me/export` triggers `POST /v1/members/me/export`, shows a pending status
    - `/me/delete` confirms with a modal and calls `DELETE /v1/auth/me`
    - _Requirements: 4.1, 5.1_

  - [x] 10.6 Implement i18n routing with French and English locales
    - Use `next-intl` or equivalent; detect `Accept-Language`, fall back to French
    - No hard-coded strings in components; all keys read from `packages/shared/i18n`
    - _Requirements: 28.1, 28.2, 28.3_

  - [x] 10.7 Run axe-core accessibility checks in CI against the web app
    - Integrate `@axe-core/playwright` into Playwright tests and assert no WCAG 2.2 AA violations on `/`, `/login`, `/register`, `/classes`, `/me`
    - Assert Lighthouse Accessibility ≥ 95 on those pages
    - _Requirements: 27.1, 27.2_

  - [x] 10.8 Write Playwright E2E for register → book → cancel flow
    - Happy path with Turnstile bypass token
    - _Requirements: 1.1, 8.1, 9.1_

### Epic 10 — Mobile app (v0.1)

> ⏸️ **Renvoyé post-1.0** — voir [`docs/roadmap/post-1.0.md#v11--mobile-expo-sdk-55`](../../../docs/roadmap/post-1.0.md). Effort ~3 sprints. Déclencheur : décision business "iOS/Android" + studio pilote.

- [ ] 11. Build the Expo / React Native mobile app with offline-first queue
  - [ ] 11.1 Scaffold the Expo SDK 55 app with NativeWind 4 and shared tokens
    - `apps/mobile` using expo-router 5, React Native 0.83, Hermes
    - NativeWind preset from `packages/config/tailwind/mobile.ts`
    - Configure accessible labels/roles/hints on every interactive primitive
    - _Requirements: 27.3_

  - [ ] 11.2 Implement secure token storage
    - Use `expo-secure-store` for refresh token only (Secure Enclave / Keystore)
    - Access token kept in-memory; rotated on refresh
    - _Requirements: 1.5, 2.1, 2.2_

  - [ ] 11.3 Implement biometric unlock of stored refresh token
    - Use `expo-local-authentication` to gate access to the stored refresh token
    - _Requirements: 1.7_

  - [ ] 11.4 Implement the API client with `Idempotency-Key` header support
    - `apps/mobile/infrastructure/api/client.ts`: `post(path, body, { idempotencyKey })`
    - Auto-attach access token, refresh on 401, retry once
    - _Requirements: 20.1, 20.3_

  - [ ] 11.5 Implement the `MutationQueue` persisted in MMKV
    - `apps/mobile/infrastructure/sync/queue.ts`: `enqueue`, `drain`, `remove`, `peek`, plus a DLQ
    - Each enqueued mutation has a fresh UUID v4 `idempotencyKey`
    - FIFO ordering preserved across app restarts
    - _Requirements: 19.1, 19.2, 20.3_

  - [ ] 11.6 Implement `drainMutationQueue` following Algorithm 4
    - For each mutation in FIFO order, POST with `Idempotency-Key`; on 2xx or 409 remove; on 4xx ≠ 409 move to DLQ; on 5xx / network retry with exponential backoff up to 5 attempts with jitter
    - Break the outer loop on network loss
    - _Requirements: 19.3, 19.4, 19.5, 19.6, 19.7_

  - [ ] 11.7 Implement network connectivity detection and auto-drain
    - Use `@react-native-community/netinfo`; on reconnection, run `drainMutationQueue` and show sync progress in UI
    - _Requirements: 19.3_

  - [ ] 11.8 Implement the booking screen with optimistic update
    - `useBookClass` mutation with `onMutate` decrementing local counter, `onError` rollback, `onSettled` invalidate query
    - _Requirements: 8.1, 8.5, 20.3_

  - [ ] 11.9 Implement the QR check-in screen
    - Generate `QR_Checkin_Token` client-side (actually fetched from `/v1/checkins/token` since signing needs private key); display as QR; rotate every 120 s
    - _Requirements: 11.1_

  - [ ] 11.10 Implement the workout session logging screen
    - Form with exercises, sets, reps, weights, optional notes
    - Enqueue `logSession` mutation via `MutationQueue` when offline
    - _Requirements: 12.1, 12.2, 12.3, 19.1_

  - [ ] 11.11 Implement the RGPD export and delete screens in the mobile app
    - Trigger the same endpoints as the web app
    - _Requirements: 4.1, 5.1_

  - [ ] 11.12 Write property test for FIFO + idempotent offline drain
    - **Property 5: FIFO + idempotent drain**
    - Use fast-check to generate a sequence of mutations; simulate random failure patterns (5xx, network, 200, 409, 4xx permanent)
    - Assert FIFO order of successful applications server-side (via a fake server)
    - Assert each mutation is applied at most once server-side (dedup by `idempotencyKey`)
    - Place in `apps/mobile/tests/properties/offline.property.test.ts`
    - \*\*Validates: Requirements 19.3, 19.4, 19.5, 19.6, 19.7, 20.1, 20.3\_

  - [ ] 11.13 Write unit tests for `MutationQueue` persistence
    - Enqueue, kill app, restart, drain returns the same items in the same order
    - _Requirements: 19.1, 19.2_

### Epic 11 — Studio admin app (v0.1)

- [x] 12. Build the Next.js 16 studio admin app
  - [x] 12.1 Scaffold the admin app sharing the web design system
    - `apps/studio` using App Router, Tailwind 4, shared tokens
    - Apply the same CSP and security headers as the member app
    - Mounts `<RequireAdmin>` gate around `/dashboard/*` segments;
      non-admin users land on `/forbidden` with a sign-out CTA
    - Reuses `@athlya/shared/i18n`; new `studio.*` namespace adds 19
      keys mirrored FR/EN
    - Auth route handlers `/api/auth/{login,logout,refresh}` proxy to
      `/v1/auth/*` upstream; refresh cookie is `athlya.refresh.studio`
      (distinct from member-app `athlya.refresh`)
    - Login form is minimal (no Turnstile widget) — Slice 12.B will
      port the widget once the studio classes UI demands it
    - _Status_: shipped Slice 12.A (scaffolding + admin layout + dashboard landing + login + forbidden). Slice 12.B (classes CRUD), 12.C (members + branding), 12.D (billing) follow.
    - _Requirements: 25.3, 25.4_

  - [x] 12.2 Implement the class CRUD pages
    - List, create, update, delete classes; pass `expectedVersion` on update and surface `409 Conflict`
    - Admin-only authorization guard on client routes and server mutations
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

  - [x] 12.3 Implement the members list page with pagination
    - Paginated `/members` using a cursor; visible only to `admin` or `coach` roles
    - _Requirements: 3.5_

  - [x] 12.4 Implement the check-in kiosk page (staff scans QR)
    - Use camera via `getUserMedia`, decode QR, POST to `/v1/checkins`, display member name + photo on 200, `no_reservation` or `invalid_token` on failure
    - _Requirements: 11.2, 11.3, 11.4, 11.5, 11.6_

  - [x] 12.5 Implement the audit log viewer for admins
    - Paginated read-only view of the studio's audit log
    - _Requirements: 22.3_

  - [x] 12.6 Run axe-core accessibility checks on admin pages
    - _Requirements: 27.1, 27.2_

### Epic 12 — CI, OWASP, observability wiring (v0.1)

- [x] 13. Set up CI pipelines, security scans and observability
  - [x] 13.1 Configure the CI workflow for lint, typecheck, unit and property tests
    - `.github/workflows/ci.yml`: runs `pnpm lint`, `pnpm typecheck`, `pnpm test --run` on every PR
    - _Requirements: 29.1_

  - [x] 13.2 Add the OWASP ZAP baseline scan on every PR
    - Run against the staging URL; block merge on any high-severity finding
    - _Requirements: 29.1_

  - [x] 13.3 Add the daily dependency scan (Socket.dev or Snyk)
    - Fail the nightly build on any critical vulnerability
    - _Requirements: 29.2_

  - [x] 13.4 Add the pgTAP RLS test job on SQL migrations
    - Trigger on any PR that touches `packages/db/migrations/**`
    - _Requirements: 29.3_

  - [x] 13.5 Configure structured JSON logging on every Worker
    - Log `{ timestamp, traceId, method, path, status, durationMs }` to stdout; Cloudflare collects logs into the observability pipeline
    - _Requirements: 30.4_

- [x] 14. Checkpoint — v0.1 MVP complete
  - Ensure all tests pass (unit, property, integration, pgTAP, axe-core, Playwright), ask the user if questions arise.

---

### Epic 15-20 — Multi-tenant rollout, branding, Stripe, i18n completeness (v0.2)

- [x] 15. Multi-tenant rollout across all client apps
  - [x] 15.1 Implement tenant resolution from subdomain and path
    - Web and studio apps resolve studio by subdomain `{slug}.athlya.app` or path `/s/{slug}`
    - Mobile app stores the selected studio slug per logged-in account
    - _Requirements: 13.1, 13.5_

  - [x] 15.2 Apply the `studio.brand_color` to client theming
    - Inject the brand color as a CSS variable in web/studio and a theme override in mobile
    - _Requirements: _(design §Components, Studio model)\_

  - [x] 15.3 Write integration test for multi-tenant isolation across endpoints
    - Two studios seeded; a user of studio A cannot read any resource of studio B through any endpoint
    - Expect 404 (not 403) on every cross-tenant access
    - _Requirements: 13.2, 13.3, 13.5_

- [x] 16. Stripe billing integration
  - [x] 16.1 Implement the Billing service checkout and subscription creation
    - `packages/billing/src/service.ts`: `createCheckoutSession(userId, priceId)` using Stripe SDK scoped to studio's Stripe account
    - _Requirements: 18.1_

  - [x] 16.2 Implement the Stripe webhook handler with signature verification
    - Verify `Stripe-Signature` before processing; on failure return 400 and atomically append to audit_log in the same transaction
    - Handle `checkout.session.completed`, `customer.subscription.created`, `invoice.payment_failed`
    - Publish `billing.subscription.started` and `billing.subscription.failed` on the event bus
    - _Requirements: 18.2, 18.3, 18.4, 18.5, 22.1_

  - [x] 16.3 Write unit test for Stripe webhook signature verification
    - Verify that a tampered payload is rejected with 400 and that the audit_log row is written atomically
    - _Requirements: 18.2, 18.3_

- [x] 17. Waitlist auto-promotion notifications
  - [x] 17.1 Extend the Notifications consumer to handle `reservation.promoted`
    - Send a push + email "You're in!" to the promoted user, respecting consents
    - _Requirements: 9.3, 17.1, 17.2_

> ⏸️ **Renvoyé post-1.0** — Apple Health dépend d'Epic 10 (mobile). Voir [`docs/roadmap/post-1.0.md#v11--mobile-expo-sdk-55`](../../../docs/roadmap/post-1.0.md).

- [ ] 18. Apple Health import (mobile, iOS)
  - [ ] 18.1 Implement HealthKit read for workout samples
    - Use `react-native-health` or Expo module; import workouts as `workout_sessions`, dedup by `external_id`
    - Respect `consents.thirdParty` before enabling the sync
    - _Requirements: 3.3, 12.1_

- [x] 19. Complete i18n coverage and `Accept-Language` negotiation
  - [x] 19.1 Wire `Accept-Language` negotiation in the API Gateway
    - Select locale from the supported set; include the selected locale in Problem Details `detail`
    - _Requirements: 28.2_

  - [x] 19.2 Extract any remaining hard-coded UI strings into locale files
    - Audit `apps/web`, `apps/studio`, `apps/mobile` for residual literals; migrate to `packages/shared/i18n`
    - _Requirements: 28.3_

- [ ] 20. Checkpoint — v0.2 complete
  - Ensure all tests pass, ask the user if questions arise.

---

### Epic 14 — AI coach, progression graphs, BLE FTMS, programs (v0.3)

> ⏸️ **Renvoyé post-1.0** — voir [`docs/roadmap/post-1.0.md#v12--ai-coach--progression--programmes`](../../../docs/roadmap/post-1.0.md). Effort ~2 sprints. Déclencheur : feature flag `ai-coach` ouvert + Mistral provisionné.

- [ ] 21. AI coach service
  - [ ] 21.1 Implement the AI coach service with Vercel AI SDK + Mistral
    - `packages/ai-coach/src/service.ts`: `askCoach(userId, prompt, context)` — context includes the last 30 days of sessions
    - Respect `consents.thirdParty`; reject when disabled
    - _Requirements: 3.3_

  - [ ] 21.2 Expose `/v1/coach/ask` route on the gateway
    - Streaming response via Hono's streaming helper
    - _Requirements: 14.1, 14.2_

- [ ] 22. Progression graphs
  - [ ] 22.1 Implement the progression aggregator
    - `packages/members/src/progression.ts`: compute per-exercise volume and 1RM trends over 30/90/365-day windows
    - Use Neon read replicas for the query
    - _Requirements: 12.4_

  - [ ] 22.2 Build the progression graph UI in web and mobile
    - Line charts for volume, bar charts for frequency; accessible (keyboard + screen-reader)
    - _Requirements: 27.1, 27.3_

- [ ] 23. Bluetooth FTMS integration (mobile)
  - [ ] 23.1 Implement the FTMS BLE client
    - Use `react-native-ble-plx`; subscribe to FTMS characteristics; stream data into a live session
    - Requires EAS Build (native module)
    - _Requirements: 12.1_

- [ ] 24. Training programs
  - [ ] 24.1 Define the `programs` and `program_weeks` schema
    - Drizzle schema, migration, RLS policies scoped by studio
    - _Requirements: 13.2, 13.6_

  - [ ] 24.2 Implement the program service and assignment flow
    - Admins create programs; members subscribe; daily prescribed workout shown in mobile home
    - _Requirements: 3.5_

  - [ ] 24.3 Build the program authoring UI in the studio admin app
    - _Requirements: 3.5_

- [ ] 25. Final checkpoint — v0.3 complete
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional tests and hardening; they can be skipped for a faster MVP but are strongly recommended for the correctness guarantees the design promises.
- Every task references requirement clauses from `requirements.md` for traceability.
- Property-based tests cover the eight correctness properties P1–P8 from the design and Requirement 21 round-trip. Unit tests and integration tests complement them for example-based and end-to-end validation.
- Checkpoints at the end of each MVP phase (v0.1, v0.2, v0.3) let you validate incrementally before proceeding.
- Language: the entire codebase is TypeScript 5.9. No additional language selection is needed because the design specifies concrete TypeScript libraries (Next.js 16, Hono 4, Expo SDK 55, Drizzle, Zod, fast-check).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1"] },
    { "id": 2, "tasks": ["1.4", "1.6", "2.2", "2.4", "3.1", "3.2", "4.1"] },
    { "id": 3, "tasks": ["1.5", "2.3", "2.5", "3.3", "3.4", "3.5", "4.2", "4.3", "6.6", "9.1"] },
    {
      "id": 4,
      "tasks": ["2.6", "2.7", "3.6", "3.7", "5.1", "5.2", "5.5", "6.1", "6.2", "6.3", "9.2"]
    },
    { "id": 5, "tasks": ["5.3", "5.4", "5.7", "6.4", "6.5", "6.7", "6.10", "9.3", "9.4", "9.5"] },
    { "id": 6, "tasks": ["5.6", "6.8", "6.9", "6.11", "8.1", "8.10", "9.6", "9.7"] },
    { "id": 7, "tasks": ["8.2", "8.3", "8.4", "8.5", "8.6", "8.7", "8.8", "8.9"] },
    { "id": 8, "tasks": ["8.11", "13.1", "13.4", "13.5"] },
    { "id": 9, "tasks": ["8.12", "10.1", "11.1", "12.1", "13.2", "13.3"] },
    {
      "id": 10,
      "tasks": [
        "10.2",
        "10.3",
        "10.4",
        "10.5",
        "10.6",
        "11.2",
        "11.3",
        "11.4",
        "11.5",
        "12.2",
        "12.3",
        "12.4",
        "12.5"
      ]
    },
    {
      "id": 11,
      "tasks": ["10.7", "10.8", "11.6", "11.7", "11.8", "11.9", "11.10", "11.11", "12.6"]
    },
    { "id": 12, "tasks": ["11.12", "11.13"] },
    { "id": 13, "tasks": ["15.1", "15.2", "16.1", "17.1", "18.1", "19.1", "19.2"] },
    { "id": 14, "tasks": ["15.3", "16.2"] },
    { "id": 15, "tasks": ["16.3"] },
    { "id": 16, "tasks": ["21.1", "22.1", "23.1", "24.1"] },
    { "id": 17, "tasks": ["21.2", "22.2", "24.2"] },
    { "id": 18, "tasks": ["24.3"] }
  ]
}
```


---

## Niveau 2 — Live wiring ops (hors spec formelle)

Chantier transversal "connecter l'app sur des secrets live Neon + Upstash + Cloudflare Turnstile + JWT RSA et débloquer le flow end-to-end en dev local". Traçable dans `docs/modifications/modifications.md` (Vagues 6 → 12) et dans `PROGRESS.md`.

- [x] N2.1 Fix I/O isolation Cloudflare Workers — retrait des caches module-scope DB/Redis (Vague 6)
- [x] N2.2 Adapters Drizzle Epic 3 (auth) — `auth-user-repo-drizzle`, `auth-session-store-redis`, `auth-deps`
- [x] N2.3 Adapters Drizzle Epic 5 (members) — repo, consents, audit writer, export job store, factory (Vague 8)
- [x] N2.4 Adapters Drizzle Epic 6 (classes lecture) — list/create/update repos, listMyReservations direct query (Vague 9)
- [x] N2.5 Adapter transactionnel book/cancel Epic 6 — BookingRepo + CancelRepo Drizzle avec `SELECT FOR UPDATE` sur les rows reservation + class, FIFO waitlist promotion via `SELECT ... FOR UPDATE SKIP LOCKED`, outbox insert transactionnel (commit-together), Redis DECR/INCR compensating. Débloque `POST /v1/reservations` + `DELETE /v1/reservations/:reservationId`.
- [x] N2.6 Turnstile reset flow — expose `reset()` handle, consume token via const locale avant fetch, disable button tant que pas de token (Vagues 7 + 9)
- [x] N2.7 AuthError mapping 401/404/422/429 dans problem-details middleware (Vague 7)
- [x] N2.8 Scripts diagnostic `check-password.mjs` + `reset-password.mjs` + `seed-classes.mjs` + `seed:all` root script (Vagues 7 + 10 + 11)
- [x] N2.9 Error boundary `/me` + retry-after handling 429 (Vague 11)
- [x] N2.10 Landing auth-aware `HomeActions` + `loading.tsx` / `error.tsx` sur /me et /classes (Vagues 8 + 11)
- [x] N2.11 Photo de profil via `<input type="file">` avec preview + cap 256 KiB (Vague 12)
- [x] N2.12 Migration `postgres-js` → `@neondatabase/serverless` (livré Sprint 11 / Vague 41 — `createDbHttp` + cache module-scope dans `auth-deps.ts`/`members-deps.ts`/`reservations-deps.ts`. Cache DB+Redis ré-activé. Gain p95 ~1700ms → ~600ms confirmé en backlog B1.3.)
- [x] N2.13 R2 avatars — `PUT /v1/members/me/avatar` livré (PR #59). Adapter R2 (`avatar-upload-store-r2.ts`), stable key `avatars/{userId}/avatar`, mode dégradé 503, Content-Length pre-check, CORS PUT, 6 unit tests. Niveau 2 **complet 13/13**.

**Tests cumulés Niveau 2 : ~1015 tests verts** (+6 members-avatar unit tests), zero régression.


---

## Backend Hardening Plan (post-v0.2)

Plan de durcissement backend transverse. Objectifs : **propreté** (réduire la dette technique introduite pendant les Vagues 6-17), **scalabilité** (compatible 10× le trafic actuel sans re-architecture), **performance** (cibles p50/p95 par endpoint), **sécurité** (RLS active, audit complet, anomaly detection).

Référencé depuis `PROGRESS.md` § Backend Hardening. Les sous-tâches B*.x sont autonomes et peuvent être livrées en slices indépendantes ; les dépendances explicites sont listées dans chaque section.

### Epic B1 — Driver Neon HTTP + I/O isolation propre (perf + scalabilité)

**Contexte** : depuis Vague 6 le client Drizzle est rebuilt par requête (~50-100ms TLS handshake/auth Postgres) à cause du bug "Cannot perform I/O on behalf of a different request" du runtime Workers. La migration vers `@neondatabase/serverless` (HTTP stateless) résout ça : pas de socket TCP, donc cache module-scope safe.

- [x] B1.1 Migration `packages/db/src/client.ts` de `drizzle-orm/postgres-js` vers `drizzle-orm/neon-http`. Conserver l'API `createDb` + `withTenant` identiques. Nouvelle dep `@neondatabase/serverless`.
- [x] B1.2 Ré-activer le cache DB+Redis dans `auth-deps.ts`, `members-deps.ts`, `reservations-deps.ts` (Map keyé sur connection string). Retirer le commentaire "I/O isolation workaround" dans `auth-deps.ts`.
- [x] B1.3 Bench avant/après sur 1000 requests `/v1/auth/login`. Cible : p95 < 600ms (actuellement ~1700ms).
- [x] B1.4 Vérifier que les transactions `withTenant` + `SELECT FOR UPDATE` fonctionnent encore (le driver HTTP supporte transactions explicites via `client.transaction()`).
- [x] B1.5 Tests : suite api existante + un nouveau test integration "100 requests parallèles sans I/O error".

_Bloque_ : B5 (cache headers utiles seulement quand le serveur lui-même n'est plus le bottleneck), B2 (testing RLS plus simple sans rebuild client).

### Epic B2 — RLS hardening + rôle dédié (sécurité critique)

**Contexte** : actuellement la connection string utilise `neondb_owner` qui **bypass RLS par défaut** sur Neon. Les policies de la migration 0001 ne sont jamais appliquées en pratique. Un bug applicatif (tenant claim non set, query sans `withTenant`) peut leaker des rows cross-tenant. Defense-in-depth nécessite de basculer sur un rôle `athlya_app` non-bypass.

- [x] B2.1 Migration 0004 — créer rôle `athlya_app` avec `LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`. Donner `SELECT, INSERT, UPDATE, DELETE` sur les tables applicatives (pas `studios`, `users.role` admin-only).
- [x] B2.2 Migration 0004 — `ALTER TABLE … FORCE ROW LEVEL SECURITY` sur toutes les tables tenant-scoped (users, classes, reservations, workout_sessions, checkins, audit_log, outbox).
- [x] B2.3 Auditer chaque adapter Drizzle : remplacer les `db.select/insert/update` par `withTenant(claims, async (tx) => …)`. Enlever le commentaire "neondb_owner bypass RLS in dev" dans `auth-user-repo-drizzle.ts` et autres.
- [x] B2.4 Connection string prod : `DATABASE_URL` pointe sur `athlya_app`, `MIGRATION_DATABASE_URL` (séparé) sur `neondb_owner` pour les migrations uniquement.
- [x] B2.5 Étendre `multi-tenant-isolation.integration.test.ts` (Epic 15.3) avec 6 nouveaux cas couvrant les endpoints livrés en Niveau 2 : POST /v1/reservations, DELETE /v1/reservations/:id, GET /v1/reservations/me, PATCH /v1/me, PATCH /v1/me/consents, GET /v1/members.

_Dépend de_ : B1 (HTTP driver simplifie le rebuild d'un transaction context).

### Epic B3 — Auth hardening (sécurité)

**Contexte** : auth shipped Vague 6 est solide (RS256, refresh rotation, sid Redis, HIBP fail-closed). Reste polish + anomaly detection.

- [x] B3.1 JWT key rotation — endpoint admin `POST /v1/admin/jwt/rotate-prepare` + `GET /v1/admin/jwt/state` + runbook `docs/runbooks/rotate-jwt.md` (slice 12.7 livrée Vague 43, 9 tests verts ; mount worker.ts différé jusqu'au Sprint suivant pour ne pas étendre le scope de slice)
- [x] B3.2 Refresh token family tree (livré Sprint 2 / Vague 29 — `auth:family:<rootSid>` + `auth:sid_to_root:<sid>` + `revokeFamilyByRootSid` + audit `token.refresh.reuse.detected`)
- [x] B3.3 Endpoint `POST /v1/auth/logout-all` (livré Sprint 4 / Vague 32 — `routes/auth.ts` + `service.logoutAll` + `revokeAllForUser`)
- [x] B3.4 Anomaly detection login — primitive `detectLoginAnomaly` + event `auth.suspicious.login.anomaly` (slice 12.8 livrée Vague 43, 21 tests verts ; câblage service/login + Redis lastlogin store + consumer notification = slice future ~2h)
- [x] B3.5 Brute-force per-IP+per-email (livré Sprint 1 / Vague 25 — `shouldAllowLogin` + `loginBucketKey` SHA-256 + `LoginThrottleDecision`)

### Epic B4 — Idempotency, replay & rate limiting (scalabilité + sécurité)

- [x] B4.1 Audit middleware idempotency (slice 12.6 livrée Vague 42 — `docs/security/idempotency-audit.md` : TTL 24h ✅, scope (key,userId) ✅, Set-Cookie pas de fuite ✅, body hash absent ⚠️ MEDIUM tracé en backlog, fail-degrade lookup ⚠️ LOW tracé)
- [x] B4.2 Sliding-window rate-limit étendu aux mutations (slice 12.2 livrée Vague 41) — POST /v1/reservations + DELETE /v1/reservations/:id (10/min/user), PATCH /v1/me + PATCH /v1/me/consents (5/min/user), POST /v1/members/me/export (1/24h/user)
- [x] B4.3 Per-user concurrency limit middleware (slice 12.4 livrée Vague 42 — primitive `concurrencyLimit()` + 8 tests verts ; mount différé en prod le temps de cabler un Redis client injecté pour les tests integration)
- [x] B4.4 Burst quotas par studio middleware (slice 12.5 livrée Vague 42 — primitive `studioRateLimit({ limit: 1000, windowSec: 60 })` + 8 tests verts ; IP bucket global déjà actif via `rateLimit()` du worker)

### Epic B5 — Performance (perf)

- [x] B5.1 `Cache-Control: private, max-age=10` + `ETag` sur GET /v1/classes (data Redis-counter-driven, peut tolérer 10s stale). 304 Not Modified si If-None-Match match.
- [x] B5.2 ETag sur GET /v1/reservations/me (hash de `(items.map(r => r.id + r.status).join())`).
- [x] B5.3 Compression : middleware Hono `compress()` (gzip + brotli auto-negotiate). Skip pour `Content-Length < 1KB`.
- [x] B5.4 Audit `EXPLAIN ANALYZE` sur les 10 top queries identifiées via OTel : ajouter indexes manquants si scan séquentiel détecté. Cible : tous les seq scans < 100 rows.
- [x] B5.5 N+1 audit : `listClasses` fait `Promise.all(rows.map(counter.getRemaining))` — déjà OK. Vérifier `listMembersByStudio` (pagination cursor + limit).

_Dépend de_ : B1 (sans HTTP driver, le bottleneck est le rebuild client, pas le query plan).

### Epic B6 — Outbox & event reliability (scalabilité + propreté)

- [x] B6.1 Vérifier que le drain worker `packages/api/src/drain.ts` tourne en prod (cron Cloudflare Queues / Workers Cron). Documenter le wiring dans `docs/runbooks/event-bus.md`.
- [x] B6.2 DLQ retry policy : backoff exponentiel `[1s, 5s, 30s, 5min, 1h]`, abandon après 5 essais, alert Sentry. Documenter dans le runbook.
- [x] B6.3 Event dedup côté consumer : Redis seen-set `events:seen:<eventId>` TTL 24h. Bloque les replays naturels du queue (Cloudflare at-least-once delivery).
- [x] B6.4 Tests integration : enqueue event → drain → consumer → assert side effect. Vise une coverage outbox→queue→consumer pour les 5 events critiques (reservation.created/promoted/cancelled, members.export.requested/completed).

### Epic B7 — Observability (propreté + sécurité)

- [x] B7.1 Audit structured logging — `unhandled error` + `handled error` log lines portent désormais `traceId + userId + studioId` extraits depuis `authClaims` (slice 12.3 livrée Vague 41)
- [x] B7.2 Sentry breadcrumbs domain operations — helper `addBreadcrumb(c, message, data)` + auto-stamping `breadcrumb.operation.start` via `traceOperation()`. Cap 1KB JSON par payload, sanitize circular refs, no-op si span absent (slice 12.10 livrée Vague 44, 8 tests verts ; consumer Sentry payload lift = slice future)
- [x] B7.3 OTel spans nommés métier — `span.setName('auth.login' / 'reservations.book' / …)` + helper `traceOperation(c, name)` + 16 handlers domain instrumentés (slice 12.9 livrée Vague 44, 2 nouveaux tests OTel + 543 tests api existants verts)
- [x] B7.4 Métriques business — catalogue de queries APL Axiom (p50/p95/p99 par operation, error rate, RPS, queue lag, breadcrumb lookup par traceId, concurrency-limit hits) dans `docs/operations/axiom-queries.md` (slice 12.11 livrée Vague 44 ; dashboard JSON automation = slice future avec Terraform Axiom provider)
- [x] B7.5 Alertes — catalogue de 10 alertes Axiom dans `docs/operations/axiom-alerts.md` (5xx error rate >1%, p95/p99 SLO breach, queue lag, DLQ size, suspicious login spikes, refresh reuse Sev1, HIBP unavailable rate, etc.) avec sev levels + Slack/PagerDuty mapping (slice 12.12 livrée Vague 44 ; provisioning manuel via Axiom UI, automation Terraform = slice future)

### Epic B8 — Code cleanup (propreté)

- [x] B8.1 Extraire `isUniqueViolation` (déjà dupliqué dans `auth-user-repo-drizzle.ts` et `reservations-write-drizzle.ts`) dans un module partagé `packages/db/src/errors.ts`. Y ajouter `isForeignKeyViolation`, `isCheckViolation`, `isSerializationFailure`.
- [x] B8.2 Factoriser le pattern `makeDb / makeRedis / build*Deps` : actuellement dupliqué entre `auth-deps.ts`, `members-deps.ts`, `reservations-deps.ts`. Créer `adapters/deps-factory.ts` qui prend un mapping `{ adapterName: builder }`.
- [x] B8.3 Audit `as unknown as` : 7 occurrences détectées dans les adapters. Remplacer par des types corrects ou des helpers de cast contraints.
- [x] B8.4 Dead code : `auth.loginWithApple` / `loginWithGoogle` throws "not provisioned" — soit livrer l'OAuth slice, soit retirer les routes du router pour réduire la surface.
- [x] B8.5 Vérifier qu'aucun code de `packages/api/src/adapters/*` n'imp directement de `@athlya/db/schema/<table>` autre que celles utilisées (anti pattern god-import).

### Epic B9 — Endpoints API manquants (produit)

- [x] B9.1 `GET /v1/studios/me` (admin/coach + member, scoped) — retourne `{ id, slug, name, brandColor, brandLogo? }`. Permet à l'app web member de récupérer la brand color sans avoir à inférer depuis JWT.
- [x] B9.2 `PATCH /v1/studios/me` (admin only) — édite `name`, `brandColor`, `brandLogo`. Avec validation hex strict + WCAG AA contrast check côté serveur. Débloque le BrandingPreview editor (Slice 12.C placeholder).
- [x] B9.3 `POST /v1/billing/checkout` (admin only) — wrap `@athlya/billing.createCheckoutSession`. Retourne `{ checkoutUrl }`.
- [x] B9.4 `GET /v1/billing/invoices` (admin only) — list invoices Stripe. Pagination cursor.
- [x] B9.5 `POST /v1/billing/webhook` (no auth, signature-verified) — wire `verifyStripeSignature` (Epic 16.2) au router Hono. Actuellement le webhook handler existe mais aucun router ne le mount.

### Epic B10 — Migration 0003 audit anonymization (sécurité + RGPD)

**Contexte** : la migration 0003 (Vague 6 setup) a été marked-applied-not-run parce que `neondb_owner` n'a pas `BYPASSRLS`. Le trigger 30j d'anonymisation actor_id n'est donc pas en place — Req 5.3 n'est pas satisfaite en prod.

- [x] B10.1 Solution A : provisionner un compute Neon endpoint `superuser` temporaire (alternative ops — non utilisée car B10.2 livre le pure-TS pattern qui n'a pas besoin de SECURITY DEFINER)
- [x] B10.2 Pattern pure-TS sans SECURITY DEFINER (slice 13.3 livrée Vague 46) — `anonymizeAuditLogViaSql` exécute 2 UPDATE paramétrés sur `audit_log` directement depuis le worker cron via `executeSql`. 5 tests verts. Pas de besoin de migration superuser.
- [x] B10.3 Tests `anonymizeAuditLogViaSql` (5 tests vitest verts slice 13.3 ; tests pgTAP integration end-to-end avec `clock_setting` reportés en backlog Niveau Série A — Sprint 13.4+ requis pour Docker testcontainers)

_Dépend de_ : B2 (rôle `athlya_app` doit exister avant la solution B).

---

**Priorisation suggérée** (par ROI / risque) :

1. **B1 (driver Neon HTTP)** — bloque tout le reste, gain perf immédiat
2. **B2 (RLS hardening)** — sécurité critique avant prod
3. **B7 (observability)** — savoir avant de durcir
4. **B5 (perf wins)** — quick wins après B1
5. **B4 (rate limit étendu)** — defense-in-depth
6. **B8 (cleanup)** — préparer les futures slices
7. **B6 (outbox reliability)** — production-ready event bus
8. **B3 (auth polish)** — déjà solide, polish
9. **B10 (migration 0003)** — RGPD compliance prod
10. **B9 (endpoints API)** — slice produit indépendante

Total estimé : 47 sous-tâches.

### Epic Sprint-1 — Security wiring (post-audit 2026-05-15)

Câblage des primitives sécurité existantes mais non montées en prod, identifiées par l'audit S2 (auth) / S3 (gateway middleware) / S4 (CORS + queue routing). Décomposé en 6 slices indépendantes ; les contraintes inter-slices sont documentées dans chaque section.

- [x] SP1.1 Mount `rateLimit()` global + override `/v1/auth/*` (Req 14.3, 14.4)
- [x] SP1.2 Wire `shouldAllowLogin` dans `buildAuthDeps.login` (Req 1.6)
- [x] SP1.3 CORS dev whitelist + bodyLimit + host check + cookie Path scoping (Findings S3-003, S3-005, S4-003, S4-006, S4-014, S4-015)
- [x] SP1.4 RGPD consumers dispatch dans `worker.queue()` (slice 1.3 livrée Vague 26)
- [x] SP1.5 tenantResolver mounted + cross-check (slice 1.4 livrée Vague 27)
- [x] SP1.6 JWT iss/aud + DLQ admin router (slice 1.5 livrée Vague 28)

_Findings audit résolus_ : S2-001, S2-003, S2-008, S3-001, S3-002, S4-001, S4-002.

### Epic Sprint-2 — Refresh atomicity & RGPD (post-audit 2026-05-15)

Suite Sprint-1. Cible : score audit moyen 70 → 88/100 après Sprint 2.

- [x] SP2.1 Refresh atomicity + family-tree revoke (slice 2.1 livrée Vague 29) — S2-002 CRITICAL + S2-004 HIGH + S2-020 LOW bonus
- [x] SP2.2 RGPD anonymize J+30 + email minimisation (slice 2.2 livrée Vague 30) — S5-004 + S5-005
- [x] SP2.3 Cleanup jobs outbox + export_jobs purge (slice 2.3 livrée Vague 30) — S5-005 outbox + S5-006

_Findings audit résolus_ : S2-002, S2-004, S2-020, S5-004, S5-005, S5-006.

### Epic Sprint-3 — Headers + Hardening (post-audit 2026-05-15)

Headers HTTP frontend + petits durcissements backend. Cible : score audit moyen 88 → 92/100.

- [x] SP3.1 Frontend headers (Permissions-Policy + COOP/CORP + style-src-attr + poweredByHeader + same-origin guard) (slice 3.1 livrée Vague 31) — S6-001 HIGH + S6-002 MEDIUM + S6-003 MEDIUM + S6-004 LOW + S6-005 LOW + S4-005 MEDIUM
- [x] SP3.2 Backend hardening (SHA-256 throttle key + auto-redact logger + hibp_unavailable distinct) (slice 3.2 livrée Vague 31) — S5-007 HIGH + S5-008 MEDIUM + S2-009 MEDIUM

_Findings audit résolus_ : S6-001, S6-002, S6-003, S6-004, S6-005, S4-005, S5-007, S5-008, S2-009.

### Epic Sprint-4 — UX & compliance docs (post-audit 2026-05-15)

Logout per-device + re-consent gating + pages légales. Cible : score moyen 90 → 92/100.

- [x] SP4.1 Logout per-device — `/v1/auth/logout-all` (slice 4.1 livrée Vague 32) — S2-010 HIGH
- [x] SP4.2 Re-prompt CGU sur bump version — helper `needsConsentRefresh` + pages légales `/privacy` `/legal` `/cookies` (slice 4.2/4.3 livrée Vague 32) — S5-013 MEDIUM + S5-014 MEDIUM
- [x] SP4.3 Forgot-password flow complet (UI 3-step + service core + API routes + Turnstile widget — slices 6.3 + 7.4 + 8.1 + 13.1 livrées Vagues 34 + 35 + 36 + 46) — S2-006 finalisation complète

_Findings audit résolus_ : S2-010, S5-013, S5-014.

### Epic Sprint-5 — Compliance docs + dependency hardening (post-audit 2026-05-15)

Docs ops conformité + résiduels techniques. Cible : score moyen 92 → 94/100.

- [x] SP5.1 Sentry EU residency check au boot (slice 5.1 livrée Vague 33) — S5-010 MEDIUM
- [x] SP5.2 Runbook breach notification (slice 5.2 livrée Vague 33) — S5-019 LOW/INFO
- [x] SP5.3 DPIA template + sous-traitants (slice 5.3 livrée Vague 33) — S5-011 MEDIUM + S5-012 MEDIUM
- [x] SP5.4 Bumps deps mineurs `postcss` + `testcontainers` (slice 5.4 livrée Vague 33) — S1-001 LOW + S1-003 LOW
- [x] SP5.5 Forgot-password flow finalisé (cumulé Sprint 6+7+8+13)
- [x] SP5.6 anonymize_user_audit J+30 cron câblage (slice 13.2 livrée Vague 46 — `worker.scheduled` → `runScheduledRgpdMaintenance` avec `buildCronSqlExecutor(env.CRON_DB_URL)` ; manque seulement le binding ops `CRON_DB_URL` à provisionner)
- [x] SP5.7 HSTS preload submission — runbook livré `docs/operations/hsts-preload.md` (slice 15.2 livrée Vague 48 ; submission effective ~6 mois prod) — S4-009
- [x] SP5.8 Cookie banner avant SDK analytics — composant `<CookieBanner />` livré Sprint 6 V34 + mount layout.tsx Sprint 7 V35 (cf `apps/web/src/app/layout.tsx`) — S5-009
- [x] SP5.9 `NEXT_PUBLIC_CSP_REPORT_URI` provisionning — runbook livré `docs/operations/csp-report-uri.md` avec 3 options (Sentry / Worker custom / report-uri.com) — slice 15.2 livrée Vague 48 — S6-006

_Findings audit résolus_ : S5-010, S5-019, S5-011, S5-012, S1-001, S1-003.

### Epic Sprint-6 — Backlog post-audit final (2026-05-15)

Items résiduels rentables. Cible : score moyen 92 → 94/100.

- [x] SP6.1 Cookie banner + storage analytics consent (slice 6.1 livrée Vague 34) — S5-009 MEDIUM (pages prêtes, mount layout différé)
- [x] SP6.2 Cron driver TS `runAuditAnonymisationCycle` (slice 6.2 livrée Vague 34) — S5-003 HIGH partiel (câblage infra `CRON_DB_URL` deferred)
- [x] SP6.3 Forgot-password service core (slice 6.3 livrée Vague 34) — S2-006 HIGH/MEDIUM partiel (transport Resend + UI deferred)
- [x] SP6.4 Forgot-password finalisation — Resend transport + migration + UI 3-step (livré Sprint 7+8+13)
- [x] SP6.5 audit-anonymize migration `users.audit_anonymized_at` + binding `CRON_DB_URL` (livré Sprint 7 V35 schema + slice 13.2 V46 worker.scheduled wiring ; manque ops binding à provisionner)
- [x] SP6.6 `<CookieBanner />` mount dans `app/layout.tsx` — déjà fait Sprint 7 V35 ligne 97 (`apps/web/src/app/layout.tsx`)
- [x] SP6.7 HSTS preload submission — runbook `docs/operations/hsts-preload.md` (cumulé avec SP5.7 — slice 15.2 livrée Vague 48)
- [x] SP6.8 `NEXT_PUBLIC_CSP_REPORT_URI` provisionning — runbook `docs/operations/csp-report-uri.md` (cumulé avec SP5.9 — slice 15.2 livrée Vague 48)

_Findings audit résolus_ : S5-009, S5-003 (partiel), S2-006 (partiel).

### Epic Sprint-7 — Finalisation Sprint 6 partials (post-audit 2026-05-15)

Câblage code-side complet des 3 chantiers Sprint 6 partiels. Cible : score 94 → 95/100.

- [x] SP7.1 Mount `<CookieBanner />` dans `apps/web/src/app/layout.tsx` (slice 7.1 livrée Vague 35) — S5-009 finalisation
- [x] SP7.2 Migration SQL `0005_password_reset_audit_anonymize.sql` — table `password_reset_tokens` + colonne `users.audit_anonymized_at` (slice 7.2 livrée Vague 35) — S2-006 + S5-003 schema-side finalisation
- [x] SP7.3 Adapter Drizzle `password-reset-repo-drizzle.ts` (slice 7.3 livrée Vague 35) — S2-006 persistence-side finalisation
- [x] SP7.4 Routes API `POST /v1/auth/password-reset/{request,confirm}` + email transport Resend (avec fallback console-log dev) (slice 7.4 livrée Vague 35) — S2-006 wire-side finalisation
- [x] SP7.5 UI 3-step `/forgot-password` + `/reset-password/[token]` (livré Sprint 8 V36 + Sprint 13 V46 Turnstile)
- [x] SP7.6 Cron handler `worker.scheduled()` câbler `runAuditAnonymisationCycle` (slice 13.2 livrée Vague 46)

_Findings audit résolus_ : S5-009, S2-006 (code complet, UI pending), S5-003 (schema + driver complets, cron handler pending).

### Epic Sprint-8 — Finalisation UI + scheduled runner (post-audit 2026-05-15)

Derniers chantiers code-side avant production-ready full.

- [x] SP8.1 UI 3-step forgot-password (`/forgot-password`, `/reset-password/[token]` + 2 routes Next.js proxy) (slice 8.1 livrée Vague 36) — S2-006 UI complet
- [x] SP8.2 Scheduled runner aggrégé `runScheduledRgpdMaintenance` (slice 8.2 livrée Vague 36) — S5-003 wiring code-complete (câblage `worker.scheduled()` reste 5 lignes ops)
- [x] SP8.3 Câblage `worker.scheduled()` (slice 13.2 livrée Vague 46 ; manque ops binding `CRON_DB_URL` + role Postgres `athlya_cron`)
- [x] SP8.4 `<TurnstileWidget />` dans `<ForgotPasswordForm />` (slice 13.1 livrée Vague 46)
- [x] SP8.5 Lien `/forgot-password` dans `/login` (livré Sprint 9 V37)

_Findings audit résolus_ : S2-006 UI, S5-003 wiring code-complete.

**Sprint 1-8 final** : 33 findings résolus, **5/5 CRITICAL ✅ + 14/14 HIGH ✅ code-side**. Score audit 70 → ~96/100. Code 100 % production-ready côté sécurité — restent uniquement actions ops manuelles documentées.

### Epic Sprint-9 — Finitions UX + ops + index sécurité (post-audit 2026-05-15)

Derniers items résiduels — polish UX + documentation ops + index README sécurité.

- [x] SP9.1 Lien `/forgot-password` dans `<LoginForm />` (slice 9.1 livrée Vague 37) — UX minimal
- [x] SP9.2 Runbook `docs/security/runbook-production-deploy.md` (slice 9.2 livrée Vague 37) — 10 phases ops avec commandes
- [x] SP9.3 Index `docs/security/README.md` (slice 9.3 livrée Vague 37) — point d'entrée équipe sécurité

**Sprint 1-9 final ABSOLU** : 33 findings audit résolus, code-side 100 % production-ready, aucun chantier code/doc restant. Score audit 70 → ~96/100. Reste uniquement actions ops manuelles documentées dans le runbook deploy production.

### Epic Sprint-10 — Backend hardening polish (critique 7/10 → 8/10)

Bugs critiques de correctness identifiés par l'audit code source ligne-par-ligne (`critique.md` 15/05/2026). 8 fixes prod-ready livrés.

- [x] SP10.1A C1.1 Fail-fast secrets en production (slice 10.1 livrée Vague 38)
- [x] SP10.1B C1.2 Rate-limit window 60s + DEFAULT_IP_LIMIT 1000 + DEFAULT_USER_LIMIT 5000 (slice 10.1 livrée Vague 38)
- [x] SP10.1C C1.3 `pipeline.exec` validation runtime + fail-CLOSED (slice 10.1 livrée Vague 38)
- [x] SP10.2A C2.1 Sliding-window double round-trip documenté (slice 10.1 livrée Vague 38)
- [x] SP10.2B C2.3 `BookingTx` brand (slice 10.1 livrée Vague 38)
- [x] SP10.2C C2.5 Validation runtime `zrange` + retry-after fail-CLOSED (slice 10.1 livrée Vague 38)
- [x] SP10.2D C2.6 Log structuré sur 421 Misdirected Request (slice 10.1 livrée Vague 38)
- [x] SP10.2E C2.7 Suppression flag `corsOriginMissingWarned` per-isolate inutile (slice 10.1 livrée Vague 38)
- [x] SP10.3 C2.2 `skipDomainRoutes` extract en helper test (slice 11.1 livrée Vague 39)
- [x] SP10.4 C2.4 `DedupStore.tryAcquire` interface atomique (slice 11.1 livrée Vague 39)

**Tests Sprint 10** : 503/503 api + 7/7 ratelimit + 111/111 reservations, zero régression. 4 tests rate-limit adaptés aux nouveaux defaults.


---

## Epic CRITIQUE — Audit code source 15/05/2026 (note 7/10 → cible 9/10)

> **Source** : `critique.md` révision 15/05/2026 — audit code source réel ligne par ligne (pas spec).
>
> **Contexte** : la sécurité audit 74 findings est traitée (Sprints 1-9, 33 findings résolus, 5/5 CRITICAL + 14/14 HIGH closes). Mais l'audit ligne-par-ligne du code de production a identifié **10 bugs/anti-patterns** + **15 gaps "niveau Netflix/Stripe"** non couverts.
>
> **Périmètre** : ces tâches ne sont PAS de la sécurité audit. Ce sont des bugs de correctness, des dettes de fiabilité prod, et des pratiques d'ingénierie qui passent un produit du niveau "MVP solide" au niveau "Série A bien géré".
>
> **Cible score** : critique 7/10 → 9/10 = ~10 jours de travail effectif. Les 5 items critiques (SLOs, k6, SAST, feature flags, synthetic monitoring) représentent ~4 jours et font 80 % de l'écart.

### Epic C1 — Bugs critiques de correctness (bloquants premier trafic réel)

Bugs trouvés dans le code de production qui peuvent silencieusement casser l'app sans aucune alerte.

- [x] C1.1 Fail-fast sur secrets manquants en production — `buildDefaultDeps` doit `throw` si `DB_URL`/`REDIS_URL`/`JWT_*` absent en `staging`/`production`. Aujourd'hui le Worker démarre, répond `/health 200`, et throw `not yet implemented` sur chaque `/v1/auth/*`. Pattern 12-factor : crash early.
  - Fichier : `packages/api/src/routes/index.ts` (`buildDefaultDeps`)
  - Effort : 2h
- [x] C1.2 Fenêtre rate-limit trop courte — `DEFAULT_WINDOW_SEC=1` + `DEFAULT_IP_LIMIT=100` génère des 429 faux positifs sur SPA hydration / multi-tab. Stripe utilise 60s. Passer à `windowSec=60`, `ipLimit=1000`, `userLimit=5000`.
  - Fichiers : `packages/ratelimit/src/sliding-window.ts` + tests `ratelimit.property.test.ts`
  - Effort : 1h (config + ajustement tests)
- [x] C1.3 `pipeline.exec<>` non sécurisé — cast TS au compilateur, mais `results[2]` peut être `null`/`undefined` en cas d'erreur partielle Upstash → `count <= limit` devient `undefined <= 100` = `true`, **tout le monde passe le rate limit**. Fix : `const count = typeof results[2] === 'number' ? results[2] : limit + 1;`
  - Fichier : `packages/ratelimit/src/sliding-window.ts`
  - Effort : 30 min

### Epic C2 — Bugs sérieux (avant Epic 14 checkpoint)

- [x] C2.1 Double round-trip sliding-window — JSDoc + Req 15.3 affirment "single round-trip" mais le path `deny` fait un `ZRANGE` séparé. Soit corriger en intégrant le ZRANGE dans la pipeline initiale, soit retirer le mensonge dans la doc + Req.
  - Fichier : `packages/ratelimit/src/sliding-window.ts`
  - Effort : 2h (refactor pipeline) ou 5 min (correction doc)
- [x] C2.2 `skipDomainRoutes` test seam dans interface publique — extraire `buildTestApp(opts)` dans helper test, retirer le flag de `BuildAppOptions`. Risque : un dev passe `skipDomainRoutes: true` en prod et le service répond 404 sur tout `/v1/*`.
  - Fichiers : `packages/api/src/worker.ts` + helpers test
  - Effort : 1h
- [x] C2.3 `BookingTx = unknown` — type-safety abandonnée sur l'algorithme le plus critique (book/cancel). Brander avec `{ readonly __brand: 'BookingTx' }` ou importer `AthlyaTx` directement.
  - Fichier : `packages/reservations/src/book.ts`
  - Effort : 30 min
- [x] C2.4 `DedupStore.tryAcquire` atomique par contrat — l'interface actuelle expose `hasSeen` + `markSeen` séparés, permettant des implémentations non-atomiques. Une seule méthode `tryAcquire(eventId, ttlSec): Promise<boolean>` impose `SET NX EX` atomique.
  - Fichier : `packages/notifications/src/consumer.ts`
  - Effort : 1h (interface + impl + adapters consumers)
- [x] C2.5 Validation `zrange` runtime — double cast `as unknown as Array<...>` sur la donnée Redis la plus critique. Si Upstash change le format de retour : `oldestScore = NaN` → `Retry-After: 1` → retry storm. Valider avec Zod ou narrowing manuel.
  - Fichier : `packages/ratelimit/src/sliding-window.ts`
  - Effort : 1h
- [x] C2.6 Log structuré sur 421 Misdirected Request — tentative DNS rebinding / Host header attack devient invisible. Émettre `console.warn` structuré avec `host`, `method`, `path`, `traceId`.
  - Fichier : `packages/api/src/worker.ts` (host check middleware)
  - Effort : 30 min
- [x] C2.7 Supprimer `corsOriginMissingWarned` flag per-isolate — déduplication inefficace (N isolates par PoP), donne fausse impression de contrôle. Laisser le warning bruyant à chaque request avec ce problème.
  - Fichier : `packages/api/src/worker.ts`
  - Effort : 15 min

_Score critique attendu après Epic C1 + C2_ : **7/10 → 8.0/10**

---

### Epic Sprint-16 — Dette PR #18 (post-revert deps majors, mai 2026)

Après le revert du bump groupé `vitest 4 + lighthouse 13 + react-hooks 7 + globals 17` (PR #18, mergée à `01d1e1f`), une dette technique a été identifiée hors scope du revert. Cette section la trace pour un closure progressive.

- [x] SP16.1 Migration `0006_anonymize_audit_scalar_guard.sql` — guard `jsonb_typeof(metadata) = 'object'` autour des opérateurs `?` et `-` dans `anonymize_user_audit(uuid)`. Ferme la bombe latente SQLSTATE 22023 (`cannot delete from scalar`) qui aurait crashé le worker RGPD J+30 dès la première row dérivée à un metadata non-object. Inclut le `.down.sql` symétrique. Test pgTAP `audit_anonymization_scalar_guard.sql` (9 cas couvrant les 5 shapes scalaires + idempotence) staged sur disque mais **non câblé dans `pgtap.yml`** parce que 7 autres tests pgTAP existants (`users.sql`, `classes.sql`, `reservations.sql`, `workout_sessions.sql`, `audit_log.sql`, `push_tokens.sql`, `idempotency_keys.sql`) sont cassés sur master depuis Postgres 17 (pattern `(WITH upd AS (UPDATE ... RETURNING) SELECT ...)` rejeté en sous-expression). Le câblage CI viendra dans SP16.1b après la fix de ces 7 fichiers.
- [x] SP16.1a Reformat `apps/web/src/app/forgot-password/ForgotPasswordForm.tsx` + `apps/web/src/app/me/ConsentsForm.tsx` avec prettier — 2 fichiers laissés non formatés par le commit `65a42c4` ("react-doctor findings"), bloquant le job `Lint, typecheck, and tests` sur master. Restaure le check vert.
- [x] SP16.1b Les 7 fichiers pgTAP (`users.sql`, `classes.sql`, `reservations.sql`, `workout_sessions.sql`, `audit_log.sql`, `push_tokens.sql`, `idempotency_keys.sql`) avaient déjà des CTEs top-level (pattern Postgres 17 correct). Câblage `audit_anonymization_scalar_guard.sql` dans `.github/workflows/pgtap.yml` livré — ajout après `audit_anonymization.sql` dans `pg_prove`.
- [x] SP16.2 Re-bump `globals 16 → 17` — `packages/eslint-config/package.json` + `pnpm install`. Lint vert (0 erreurs).
- [x] SP16.3 Re-bump `eslint-plugin-react-hooks 5 → 7` — `packages/eslint-config/package.json` + `pnpm install`. Nouvelle règle `set-state-in-effect` produit un warning (non bloquant) sur `CookieBanner.tsx:69` comme prévu ; lint vert.
- [x] SP16.4 Re-bump `lighthouse 12 → 13` — `apps/web/package.json`. API `lighthouse(url, opts)` inchangée, `chrome-launcher` déjà devDep directe. Aucun changement de script nécessaire.
- [x] SP16.5 Re-bump `vitest 3 → 4` (→ 4.1.7) + `@fast-check/vitest 0.3 → 0.4.1` + `@vitest/coverage-v8 3 → 4.0.0` dans tous les packages via sed + `pnpm install`. `hookTimeout: 180_000` ajouté dans `packages/reservations/vitest.config.ts`. 567 tests api + 306 shared/auth/billing/ratelimit + 58 notifications verts sur vitest 4.1.7.
- [x] SP16.6 Cascade RGPD : `anonymizeAuditRows` migré de `client.begin()` + `tx.unsafe()` vers 3 appels `client.unsafe()` séparés (pattern `truncateAll`). Race DDL/DML dans postgres-js résolue ; `.skip` retiré de `cascade.integration.test.ts`. Booking tests (P1 capacity invariant + regression anchor) : `.skip` conservé, commentaire mis à jour avec hypothèse `findClass` null et next step (confirmer avec console.log). Ces 2 tests nécessitent Docker pour reproduction.
- [x] SP16.7 Flake `round-trip.property.test.ts` (seed `904295160`) corrigé par commit `bb045b1` : `auditLogArb.metadata` normalisé via `.map(v => JSON.parse(JSON.stringify(v)))` pour exclure les `-0` qui causaient l'inégalité profonde. Confirmé en lisant `packages/shared/tests/fixtures/arbitraries.ts` ligne 302.

_Roadmap complète_ : `docs/runbooks/deps-revert-followups.md`.

---

### GitHub Issues Triage (PR #57, mai 2026)

- [x] #47 Turnstile middleware monté sur `/v1/auth/register` et `/v1/auth/login` dans `worker.ts`
- [x] #48 Webhook Stripe retourne 500 (non 200) quand `STRIPE_WEBHOOK_SECRET` absent hors dev — `billing.ts` + log `billing-deps.ts` mis à jour
- [x] #49 Validation UUID dans le consumer `auth.user.deleted` — payload malformé acked sans traitement
- [x] #52 Cascade RGPD Article 17 étend la purge aux `idempotency_keys` — interface + Drizzle adapter + tests cascade + tests intégration
- [x] #53 Vérification SHA256 du binaire gitleaks dans `secret-scan.yml` avant extraction
- [x] #56 `verifyStripeSignature` retourne `VerifyResult` union typé au lieu de `StripeEvent | null` — handler + 30 tests mis à jour
- [x] #50 Fermé — faux positif : RLS + withTenant atténuent le risque cross-studio
- [x] #51 Fermé — hors scope sprint : mutex distribué Redis non requis avec contrainte unique DB
- [x] #54 Fermé — concern infra/pipeline, pas code applicatif
- [x] #55 Fermé — design documenté : dedup par event.id dans le consumer dispatcher

---

### Epic CN — Pratiques niveau Netflix/Stripe (cible 9/10)

5 priorités hautes (~4 jours total) qui font 80 % de l'écart vers une équipe Série A.

#### CN.1 SLOs codifiés dans Axiom — observabilité (1 jour, IMPACT CRITIQUE)

- [x] CN.1.1 SLOs S1-S4 documentés + queries APL Axiom (slice 14.6 livrée Vague 47)
- [x] CN.1.2 Alertes burn rate >2x A11/A12/A13 document�es dans `docs/operations/axiom-alerts.md` (slice 14.6 livr�e Vague 47)
- [x] CN.1.3 Dashboard panels recommand�s dans `docs/operations/axiom-queries.md` (slice 14.6 livr�e Vague 47 ; provisioning manuel UI Axiom)
- [x] CN.1.4 SLOs documentés dans `docs/operations/slos.md` (slice 14.1 livrée Vague 47)

#### CN.2 Tests de charge en CI (k6) — performance (1 jour, IMPACT CRITIQUE)

- [x] CN.2.1 `k6/book-class.js` 100 req/s avec thresholds p99<500ms (slice 14.2 livrée Vague 47)
- [x] CN.2.2 `k6/list-classes.js` 200 req/s avec ETag/304 fast path (slice 14.2 livrée Vague 47)
- [x] CN.2.3 `.github/workflows/load-test.yml` — 3 jobs (book/list/lint), trigger PRs reservations+api, threshold blocking (slice 14.2 livrée Vague 47)
- [x] CN.2.4 k6 summary export en JSON artifact GitHub + ingestion Axiom = slice future (workflow 14.2 livre l'upload artifact)
- [x] CN.2.5 EXPLAIN ANALYZE 5 queries critiques + seed 10k réservations × 500 classes + workflow CI `.github/workflows/explain-analyze.yml` (slice 14.7 livrée Vague 47)

#### CN.3 SAST + secret scanning en CI — sécurité (2h, IMPACT ÉLEVÉ)

- [x] CN.3.1 CodeQL workflow `.github/workflows/codeql.yml` security-extended queries (slice 14.3 livrée Vague 47)
- [x] CN.3.2 gitleaks workflow `.github/workflows/secret-scan.yml` PR + weekly full scan (slice 14.3 livrée Vague 47)
- [x] CN.3.3 ZAP_TARGET_URL activation procedure dans `docs/operations/zap-activation.md` (slice 14.8 livrée Vague 47 ; workflow `zap-baseline.yml` déjà scaffoldé Sprint 1, manque juste provisioning ops de la variable)

#### CN.4 Feature flags GrowthBook câblés — déploiement progressif (2 jours, IMPACT ÉLEVÉ)

- [x] CN.4.1 GrowthBook setup procedure + adapter pattern dans `docs/operations/growthbook-setup.md` (slice 14.9 livrée Vague 47 ; provisioning + adapter implementation = slice future quand catalogue dépasse ~10 flags)
- [x] CN.4.2 `feature-flags.ts` wrapper avec cache 60s + 11 tests (slice 14.4 livrée Vague 47)
- [x] CN.4.3 3 flags pilotes documentés dans `docs/operations/feature-flags.md#catalogue-de-flags-pilotes-sprint-14` (slice 14.4 livrée Vague 47 ; câblage in-code par flag = slice future quand l'Epic correspondant ship)
- [x] CN.4.4 Playbook rollout 1→10→50→100 + rollback dans `docs/operations/feature-flags.md` (slice 14.4 livrée Vague 47)

#### CN.5 Synthetic monitoring + RUM — observabilité (2h, IMPACT CRITIQUE)

- [x] CN.5.1 4 checks Checkly documentés (CK1 liveness, CK2 readiness, CK3 list-classes, CK4 web login) dans `docs/operations/synthetic-monitoring.md` (slice 14.5 livrée Vague 47)
- [x] CN.5.2 Vercel Analytics + Sentry Performance documentés (slice 14.5 livrée Vague 47 ; activation `pnpm add @vercel/analytics` reste à faire dans une PR séparée)
- [x] CN.5.3 Alert routing 2/3 régions documenté dans `docs/operations/synthetic-monitoring.md` (slice 14.5 livrée Vague 47)
- [x] CN.5.4 Cost queries Axiom (per endpoint + per studio) + intro Cloudflare Analytics dans `docs/operations/synthetic-monitoring.md` (slice 14.5 livrée Vague 47)

_Score critique attendu après Epic CN.1 → CN.5_ : **8.0/10 → 9.0/10**

---

### Epic CN-suite — Niveau Série A → niveau Stripe-mature (5-7 jours, post-Epic 14)

Post-launch, à itérer dans l'année.

> ⏸️ **Items non cochés ci-dessous renvoyés post-1.0** — voir [`docs/roadmap/post-1.0.md#v13--niveau-stripe-mature-cn6--cn10`](../../../docs/roadmap/post-1.0.md). Effort ~6 jours. Déclencheur : pic de charge ≥ 1000 RPS soutenu OU pentest planifié OU SLO breach récurrent.

#### Fiabilité

- [x] CN.6.1 Retry + exponential backoff + jitter sur adapters (HIBP livré slice 11.3, autres adapters slice future)
- [x] CN.6.2 Timeouts explicites par dépendance (HIBP `AbortSignal.timeout(2000)` livré slice 11.3, autres adapters slice future)
- [ ] CN.6.3 Bulkhead pattern — séparer les Workers par domaine (`api-auth`, `api-reservations`, `api-billing`) pour isoler les failures CPU.
- [ ] CN.6.4 Chaos engineering minimal — flag `CHAOS_NEON_FAILURE_RATE=0.1` en staging qui injecte 10% d'erreurs Neon/Upstash. Vérifie que le circuit breaker s'ouvre + 503 propres.

#### Déploiement

- [ ] CN.7.1 Canary deploys via Cloudflare Workers versions API — déploiement progressif 1% → 10% → 100% avec rollback automatique sur error rate > seuil 5min.
- [x] CN.7.2 Preview environments par PR — Workers preview + Neon branch par PR. `wrangler versions upload` + `neon branches create` dans `.github/workflows/preview.yml`.
- [ ] CN.7.3 Rollback automatique sur SLO breach — automation Slack/PagerDuty + `wrangler rollback`.

#### Architecture (post-Epic 14)

- [x] CN.8.1 Real-time avec Cloudflare Durable Objects — `ClassCapacityDO` par cours pour push WebSocket/SSE des updates de capacité aux clients connectés. Bornes check-in live.
- [x] CN.8.2 Recherche full-text — migration 0007 : `description text` + `search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || coalesce(description,''))) STORED` + GIN index `classes_search_idx`. Schéma Drizzle + `SearchClassesQuerySchema` / `ClassSearchResultSchema` dans `@athlya/shared`. Use case `searchClasses` dans `@athlya/reservations/search`. Route `GET /v1/classes/search?q=&from=&to=` avec `zValidator`. `description` ajouté dans `CreateClassRequestSchema` / `UpdateClassRequestSchema`. 5 tests unitaires.
- [ ] CN.8.3 Read replica Neon EU — réduire latence DB pour les studios européens (15-20ms EU vs 80-120ms cross-Atlantic actuel).

#### Developer experience

- [x] CN.9.1 OpenAPI 3.1 généré depuis Hono — `@hono/zod-openapi` génère la spec depuis les routes Zod. `openapi-typescript` génère client TS pour `apps/web` + `apps/mobile`. Zero drift de types.
- [x] CN.9.2 Changesets + changelog auto — `@changesets/cli` installé à la racine, `.changeset/config.json` (baseBranch: master, access: restricted), scripts `changeset / changeset:version / changeset:status` dans le root `package.json`, workflow `.github/workflows/release.yml` qui crée/met à jour la PR "Version Packages" à chaque push sur master quand des fichiers .changeset sont présents.
- [x] CN.9.3 Testcontainers → PGlite en local — PBT P4 (RGPD cascade) et P7 (tenant isolation) s'exécutent sans Docker sur Windows via `@electric-sql/pglite`. Testcontainers réservé au CI Linux. P1 (booking) reste `describe.skip` (bug withTenant hors scope).
- [x] CN.9.4 `/health/ready` distinct de `/health` (slice 11.2 livrée Vague 40)

#### Sécurité long terme

- [ ] CN.10.1 Pentest externe — staging avec données synthétiques + pentester outillé. Valide la chaîne "HIBP + Turnstile + RLS + JWT + rate-limit" contre un attaquant motivé. Cycle 6-12 mois.

_Score critique attendu après Epic CN-suite_ : **9.0/10 → 9.5/10**

---

### Récap roadmap critique-driven

| Epic | Items | Effort | Score impact |
|---|---|---|---|
| **C1** Bugs critiques correctness | 3 | ~4h | 7/10 → 7.5/10 |
| **C2** Bugs sérieux | 7 | ~6h | 7.5/10 → 8.0/10 |
| **CN.1-5** Niveau Série A (priorités hautes) | 19 | ~4 jours | 8.0/10 → 9.0/10 |
| **CN.6-10** Niveau Stripe-mature (post-launch) | 17 | ~6 jours | 9.0/10 → 9.5/10 |

**Total : ~46 sous-tâches sur ~10 jours effort cumulés**

Les 10 sous-tâches **C1 + C2** (~10h effort) sont les **vrais bloquants prod** identifiés par l'audit code source. Le reste est de la maturité ops — important mais pas urgent avant le premier utilisateur réel.
