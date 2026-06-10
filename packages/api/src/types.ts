/**
 * Shared gateway types — Hono `Bindings` (the Cloudflare Worker `env`
 * shape) and `Variables` (per-request context Hono's `c.set(…)` /
 * `c.get(…)` writes and reads).
 *
 * Kept in its own module so every piece of the gateway — middleware,
 * domain routes, tests — imports the same declarations without a
 * circular dependency against `worker.ts`. The file stays intentionally
 * thin: no runtime code, no helpers — just types + one enum-style
 * union.
 *
 * Task 8.1 owns the initial surface. Later tasks will extend
 * {@link AthlyaVariables} (e.g. `authClaims`, `tenantId`, `member`) by
 * re-declaring module augmentation; the interface is written as a
 * regular `interface` (not a type alias) to keep that extension
 * ergonomic.
 *
 * Related requirements: 5.5 (EU-only regional pinning, consumed by
 * `wrangler.toml`), 23.3 (named environments dev/staging/prod),
 * 30.4 (structured logging context — `traceId`, `logger`).
 */

import type { StructuredLogger } from './logging.js';
import type { TraceSpan } from './middleware/otel.js';
import type { DurableObjectNamespace, Queue, R2Bucket } from '@cloudflare/workers-types';

/* ------------------------------------------------------------------ */
/*  Hyperdrive (write-path pooling)                                    */
/* ------------------------------------------------------------------ */

/**
 * Minimal Hyperdrive binding surface — postgres-js wire URL for the
 * booking/cancel write path. Matches Cloudflare's runtime binding.
 */
export interface AthlyaHyperdriveBinding {
  readonly connectionString: string;
}

/* ------------------------------------------------------------------ */
/*  Environment discriminator                                          */
/* ------------------------------------------------------------------ */

/**
 * Named deployment targets. The string is surfaced verbatim by the
 * `/health` endpoint (`environment` field) and by every log line
 * (via `createLogger({ env })`), so operators can filter Loki / Tail
 * Workers on the exact value.
 *
 * `'dev'`         — local `wrangler dev` and CI preview runs.
 * `'staging'`     — `staging.api.athlya.app`, full infra but isolated
 *                   data stores. Exercised by the E2E suite.
 * `'production'`  — `api.athlya.app`. Serves real tenants.
 *
 * Kept as a closed union (not an enum) so every exhaustive `switch`
 * on the field fails the typecheck when a new environment lands —
 * enums allow an unknown value to slip through and defeat that guard.
 */
export type AthlyaEnvironment = 'dev' | 'staging' | 'production';

/* ------------------------------------------------------------------ */
/*  Bindings (runtime env)                                             */
/* ------------------------------------------------------------------ */

/**
 * Cloudflare Worker `env` shape.
 *
 * Every field corresponds either to a `[vars]` entry in
 * `wrangler.toml` (non-secret configuration, visible in the dashboard)
 * or to a binding (queue, KV, D1, …) declared in the same file.
 * Secrets (`REDIS_TOKEN`, `DB_URL`, `JWT_JWKS_URL`, `SENTRY_DSN`) are
 * typed here as plain strings but set via `wrangler secret put` per
 * environment — they never land in `wrangler.toml`.
 *
 * Design notes:
 *
 * - `EVENTS_QUEUE` is typed `Queue<unknown>` so the producer accepts
 *   whatever envelope `publish.ts` serialises. Domain code narrows
 *   the payload at the call site.
 * - `ENVIRONMENT` is the discriminator read by observability code
 *   and the `/health` endpoint — keep it in sync with
 *   {@link AthlyaEnvironment}.
 * - `SENTRY_DSN` is optional because staging / dev can run without a
 *   Sentry project (a warn log is emitted and error reporting is
 *   suppressed — implementation lands in task 14.x).
 * - `VERSION` is injected by CI (`wrangler deploy --var VERSION=...`)
 *   so `/health` can echo the deployed build id back to smoke-test
 *   harnesses. Defaulted to a semver-ish placeholder in
 *   `wrangler.toml` for local dev.
 *
 * Future tasks extend this interface (KV caches, D1 / Postgres client
 * factories, Turnstile secret, Stripe signing secret). Do NOT add
 * them here until the task that introduces them lands — the
 * interface is the single source of truth for "what the gateway
 * requires at boot".
 */
export interface AthlyaBindings {
  /** Named environment the Worker was deployed to. */
  readonly ENVIRONMENT: AthlyaEnvironment;

  /**
   * Producer binding declared in `wrangler.toml` (task 9.4).
   * Domain services publish through this via `@athlya/api/events/publish`.
   * Legacy topic — new events route to lane-specific queues (issue #125).
   */
  readonly EVENTS_QUEUE: Queue<unknown>;

  /**
   * Notifications lane (`reservation.*`, `billing.subscription.failed`).
   */
  readonly EVENTS_NOTIFICATIONS_QUEUE: Queue<unknown>;

  /**
   * RGPD lane (`auth.user.deleted`, `members.export.*`).
   */
  readonly EVENTS_RGPD_QUEUE: Queue<unknown>;

  /**
   * Producer binding for the dead-letter queue (`athlya-events-dlq`,
   * hardening task H2). Used by `reject-unknown-queue-event.ts` to
   * quarantine payloads whose `event.type` is not handled by any
   * consumer lane (issue #132). The DLQ drain handler in
   * `src/events/drain-dlq.ts` tracks observed messages in Redis.
   */
  readonly EVENTS_DLQ: Queue<unknown>;

  /**
   * Postgres connection string. Injected as a secret by CI; the
   * dev value is loaded from `.dev.vars` (git-ignored).
   *
   * Slice B2 (Req H1) — once the production cutover lands, this
   * URL points to the `athlya_app` role (NOBYPASSRLS). Until the
   * cutover, both `DB_URL` and {@link MIGRATION_DB_URL} fall back
   * to the BYPASSRLS owner role, which is non-disruptive (RLS
   * policies are skipped just like before B2).
   */
  readonly DB_URL: string;

  /**
   * Cloudflare Hyperdrive binding for interactive write transactions
   * (`bookClass`, `cancelReservation`). When present, the write-path
   * postgres-js client is cached per isolate with a small pool; when
   * absent, dev/preview fall back to direct `DB_URL` (one client per
   * request). Provisioned via `[[env.*.hyperdrive]]` in
   * `wrangler.toml` after dashboard setup (issue #62).
   */
  readonly HYPERDRIVE?: AthlyaHyperdriveBinding;

  /**
   * Privileged Postgres connection string used **only** by the
   * migration runner (`packages/db/scripts/migrate.mjs`). Points
   * to the BYPASSRLS owner role (`neondb_owner` on Neon) so DDL
   * + role/grant management succeed.
   *
   * Optional at the type level — when absent, the migration script
   * falls back to {@link DB_URL}. **Never** read this binding from
   * the runtime API code; it would defeat the RLS hardening.
   */
  readonly MIGRATION_DB_URL?: string;

  /**
   * Strict CORS allow-list — exactly ONE origin in staging/production
   * (the matching member-facing or studio frontend). Optional in
   * `dev` where the worker hard-codes a localhost whitelist
   * (`http://localhost:{3000,3001}` + `127.0.0.1` variants).
   *
   * **Required in staging/production**: `buildApp` mounts a sentinel
   * middleware that refuses every request with a 500
   * `configuration_error` Problem Details body when this binding is
   * empty in those environments (Slice 1.2-A — Sprint-1 SP1.3, audit
   * finding S4-014). The fail-loud pattern matches `TURNSTILE_SECRET`:
   * a missing secret outside dev surfaces a clean 500 instead of
   * silently breaking cross-origin requests with no signal in the
   * Worker logs.
   *
   * Provisioned via:
   *   `wrangler secret put CORS_ORIGIN --env <staging|production>`
   *
   * Format: a single fully-qualified origin, no trailing slash, no
   * path. Example: `https://app.athlya.app`.
   */
  readonly CORS_ORIGIN?: string;

  /** Upstash Redis REST URL. */
  readonly REDIS_URL: string;

  /** Upstash Redis REST token. Secret — never committed. */
  readonly REDIS_TOKEN: string;

  /**
   * JWKS endpoint of the identity provider (Clerk / Auth.js).
   * Task 8.2 caches the keys returned by this URL.
   */
  readonly JWT_JWKS_URL: string;

  /**
   * Sentry DSN. Optional — the observability middleware (task 14.x)
   * checks for `undefined` and silently skips initialisation when
   * absent.
   */
  readonly SENTRY_DSN?: string;

  /**
   * Resend API key used by queue-side transactional notifications
   * dispatch (`reservation.*`, `billing.subscription.failed`).
   *
   * Optional at the type level so local dev can run with the
   * console-log fallback from `adapters/notifications-deps.ts`.
   * Staging/production should set it via:
   *   `wrangler secret put RESEND_API_KEY --env <env>`
   */
  readonly RESEND_API_KEY?: string;

  /**
   * Optional sender identity for Resend, e.g.
   * `Athlya <noreply@athlya.app>`.
   *
   * When unset, adapters default to `Athlya <noreply@athlya.app>`.
   */
  readonly RESEND_FROM?: string;

  /**
   * Expected `iss` claim on every Bearer JWT — Slice 1.5 (Sprint 1
   * — SP1.6, audit finding S2-005). Plumbed straight into
   * `jose.jwtVerify({ issuer })` by `worker.ts` so a token issued
   * by another Athlya service (or any third party that ever shares
   * our JWKS) cannot land on the gateway.
   *
   * Optional at the type level so test fixtures can omit it; the
   * gateway falls back to `'athlya'` when unset. The default value
   * matches the Auth service's `iss` claim convention.
   */
  readonly JWT_ISSUER?: string;

  /**
   * Expected `aud` claim on every Bearer JWT — Slice 1.5 (Sprint 1
   * — SP1.6, audit finding S2-005). Same plumbing as
   * {@link JWT_ISSUER} but for the audience side of the
   * cross-service confused-deputy defence.
   *
   * Optional at the type level. The gateway derives a sane
   * default from {@link ENVIRONMENT} when unset:
   *
   *   - `dev`        → `athlya-api-dev`
   *   - `staging`    → `athlya-api-staging`
   *   - `production` → `athlya-api-production`
   *
   * Production deploys are expected to set this binding explicitly
   * to override the convention.
   */
  readonly JWT_AUDIENCE?: string;

  /**
   * Semver-ish identifier of the currently deployed build. CI sets
   * this on `wrangler deploy`; tests and local dev use the
   * `wrangler.toml` default.
   */
  readonly VERSION: string;

  /**
   * OTLP/HTTP endpoint the OTel middleware (task 8.6) POSTs
   * `ResourceSpans` envelopes to. Optional — when absent the
   * middleware records spans in memory but skips the export,
   * matching local-dev / test expectations.
   *
   * For Axiom (default target), this is
   *   `https://api.axiom.co/v1/traces`.
   */
  readonly OTEL_EXPORTER_OTLP_ENDPOINT?: string;

  /**
   * Extra headers injected on every OTLP export call, formatted as
   * `key1=value1,key2=value2` per the OpenTelemetry environment
   * convention. Axiom authenticates with
   * `Authorization=Bearer <token>,X-Axiom-Dataset=athlya-api`;
   * the token is a secret set via `wrangler secret put
   * OTEL_EXPORTER_OTLP_HEADERS` and MUST NOT land in
   * `wrangler.toml`. Optional for the same reason as the endpoint.
   */
  readonly OTEL_EXPORTER_OTLP_HEADERS?: string;

  /**
   * OTLP export sample rate in `[0, 1]`. When unset, defaults by
   * `ENVIRONMENT`: production `0.1`, staging `0.5`, dev `1.0`.
   * 5xx responses are always exported; `/health*` uses at most `0.01`.
   */
  readonly OTEL_SAMPLE_RATE?: string;

  /**
   * Cloudflare Turnstile server-side secret (task 8.9). Consumed by
   * the `turnstile()` middleware when it POSTs to the siteverify
   * endpoint. Set via `wrangler secret put TURNSTILE_SECRET` per
   * environment.
   *
   * Optional at the type level because the middleware supports a
   * dev-only bypass: when `ENVIRONMENT === 'dev'` and no secret is
   * set, the middleware logs a warning and calls `next()` without
   * verification. In `staging` / `production`, a missing secret is
   * treated as a misconfiguration and yields HTTP 500 —
   * the missing-secret signal is loud, not silent.
   */
  readonly TURNSTILE_SECRET?: string;

  /**
   * Cloudflare R2 bucket binding holding member avatar binaries
   * (Slice 1.3 — Sprint 1, finding S5-002). Consumed by
   * {@link import('@athlya/members').AvatarStore} via
   * `adapters/avatar-store-r2.ts` during the RGPD Article 17
   * cascade.
   *
   * **Optional** at the type level — until the bucket is
   * provisioned via `wrangler r2 bucket create athlya-avatars-{env}`,
   * the cascade falls back to a degraded-mode no-op (logs a warn,
   * does not throw) so the SQL-side compliance window keeps
   * closing on schedule. See `avatar-store-r2.ts` for the full
   * fallback rationale.
   */
  readonly AVATARS_BUCKET?: R2Bucket;

  /**
   * Base URL for the public R2 avatar CDN (N2.13 — avatar upload).
   *
   * Examples:
   *   - `https://avatars.athlya.app` (dedicated R2 custom domain)
   *   - `https://api.athlya.app/v1/members/avatar` (Worker proxy)
   *
   * When absent, `PUT /v1/members/me/avatar` responds 503
   * `avatar_upload_not_configured`. Optional until the R2 bucket and
   * a public domain are provisioned — set via `wrangler.toml` under
   * `[vars]` or `wrangler secret put AVATARS_PUBLIC_URL`.
   */
  readonly AVATARS_PUBLIC_URL?: string;

  /**
   * Cloudflare R2 bucket binding holding RGPD data-export ZIP
   * archives (Slice 1.3 — Sprint 1, finding S5-001). Consumed by
   * the {@link import('@athlya/members').BlobStore} adapter via
   * `adapters/export-deps.ts` to upload the assembled archive
   * before signing a 72-hour download URL.
   *
   * **Optional** at the type level — until the bucket is
   * provisioned via `wrangler r2 bucket create athlya-exports-{env}`,
   * the export consumer marks the job `failed` with reason
   * `exports_bucket_missing` so the user-facing surface surfaces a
   * clear error instead of looping forever. See `export-deps.ts`
   * for the full fallback rationale.
   */
  readonly EXPORTS_BUCKET?: R2Bucket;

  /**
   * Durable Object namespace for per-class WebSocket capacity fanout
   * (CN.8.1 — Sprint 8). Each class gets its own DO instance keyed by
   * `classId` via `idFromName`.
   *
   * **Optional** at the type level — when absent (local dev, preview
   * without DO support) the notify helper and the capacity WS endpoint
   * both degrade gracefully: notifications are silently skipped and
   * the endpoint returns 503.
   */
  readonly CLASS_CAPACITY_DO?: DurableObjectNamespace;

  /**
   * Max simultaneous WebSocket subscribers a single `ClassCapacityDO`
   * instance accepts before shedding new upgrades (issue #141 / audit
   * P6). A DO is single-threaded and one hot class concentrates every
   * subscriber on one isolate; past this cap the broadcast fan-out and
   * connection memory stop being free. Excess clients get a 503 +
   * `X-Capacity-Fallback: poll` so they degrade to polling
   * `GET /v1/classes` instead of hammering the saturated DO.
   *
   * Optional string env var (Workers vars are strings). Parsed as an
   * int; absent / invalid / non-positive → {@link DEFAULT_CLASS_CAPACITY_MAX_WS}.
   */
  readonly CLASS_CAPACITY_MAX_WS?: string;

  /**
   * Postgres connection string for the RGPD maintenance cron role
   * (`athlya_cron`). Used by `worker.scheduled()` for J+30 user
   * anonymisation, outbox/export_jobs purge, and audit_log scrubbing.
   *
   * **Required in staging/production**: missing binding skips the
   * maintenance cycle with a structured `configuration_error` log
   * (issue #64) and makes `/health/ready` return 503. Dev may omit.
   *
   * Provisioned via:
   *   `wrangler secret put CRON_DB_URL --env <staging|production>`
   *
   * Format: `postgresql://athlya_cron:...@host/athlya?sslmode=require`
   */
  readonly CRON_DB_URL?: string;

  /**
   * Neon read-replica connection string for the EU region (CN.8.3).
   *
   * When set, read-only queries originating from European Cloudflare
   * colos (`cf.continent === 'EU'`) are routed to this replica instead
   * of the primary `DB_URL`. Writes always use the primary.
   *
   * Absent → zero behaviour change; every query uses `DB_URL` as before.
   *
   * Provisioned via:
   *   `wrangler secret put DB_URL_EU --env production`
   */
  readonly DB_URL_EU?: string;
}

/* ------------------------------------------------------------------ */
/*  Variables (per-request context)                                    */
/* ------------------------------------------------------------------ */

/**
 * Per-request context Hono middleware writes via `c.set(key, value)`
 * and downstream handlers read via `c.get(key)`. The three fields
 * below are populated by the tracing + logging middleware in
 * `worker.ts` before any route handler runs.
 *
 * Subsequent tasks widen this interface:
 *
 *   - Task 8.2 adds `authClaims?: { userId; studioId; role }`
 *   - Task 8.3 adds `tenantId: string` + `studioId: string`
 *   - Task 8.4 adds `rateLimitRemaining: number`
 *
 * Every addition should be documented with the task number that
 * introduced it so the provenance of the fields stays traceable.
 */
export interface AthlyaVariables {
  /**
   * 32-hex W3C trace id for the current request. Extracted from the
   * inbound `traceparent` header when present (RFC-compliant) or
   * generated fresh as a UUID v4 when absent. Surfaces in every
   * log line and on the `/health` response.
   */
  traceId: string;

  /**
   * Request-scoped structured logger pre-filled with `traceId` +
   * `env`. Callers should prefer this over creating a fresh logger
   * so every log line in a request is correlatable.
   */
  logger: StructuredLogger;

  /**
   * `Date.now()` timestamp of when the request entered the Worker.
   * The serve-log middleware uses it to compute `durationMs`
   * (Req 30.4).
   */
  startedAt: number;

  /**
   * Populated by the auth middleware (task 8.2). `undefined` on
   * public routes — domain handlers behind `jwtAuth()` can assume
   * it is set.
   *
   * Shape matches the verified JWT's canonical claims:
   *   - `userId`  ← `sub`
   *   - `studioId` ← `studio`
   *   - `role`    ← `role` (closed union, rejected at verify time if
   *                        any other value sneaks into the token)
   */
  authClaims?: {
    userId: string;
    studioId: string;
    role: 'member' | 'admin' | 'coach';
  };

  /**
   * Per-request OpenTelemetry span (task 8.6). Populated by the
   * `tracing()` middleware before any domain middleware runs so
   * downstream code can call
   *
   *   c.get('span')?.addAttribute('studio.id', studioId);
   *   c.get('span')?.addEvent('reservation.confirmed', { id });
   *
   * without branching on the middleware being mounted. Absent only
   * when the middleware has not been wired — in the default
   * gateway skeleton built by `worker.ts`, it is always set.
   */
  span?: TraceSpan;

  /**
   * Tenant slug resolved from the request `Host` header or the
   * `/s/<slug>/...` path prefix by the `tenantResolverMiddleware()`
   * (Slice 1.4 — Sprint 1 — SP1.5, audit finding S2-007). The
   * pure resolver runs unconditionally as one of the first
   * middlewares in `worker.ts`; this field is set whenever the
   * resolver returned a `'subdomain'` or `'path'` source.
   *
   * `undefined` when the request targets the apex host
   * (`api.athlya.app`), an IP literal, or a dev hostname — those
   * cases are legitimate (mobile API on apex, dev / staging) and
   * the cross-check defers to the JWT claim alone.
   *
   * Do NOT use this field for tenant-scoped data filtering: that
   * remains the exclusive responsibility of the JWT `studio` claim
   * (`authClaims.studioId`) and the RLS policies fed by
   * `withTenant`. The slug is informational only — it is consumed
   * by the cross-check guard to refuse host-vs-claim mismatches
   * (Req 13.2).
   */
  tenantSlug?: string;

  /**
   * Origin of the resolved tenant — mirrors the discriminator on
   * `TenantResolution` from `middleware/tenant-resolver.ts`.
   * `'none'` is recorded explicitly (rather than `undefined`) when
   * the resolver ran but found no tenant, so observability can
   * distinguish "resolver did not run" from "request targets the
   * apex". Set in lock-step with {@link tenantSlug}.
   */
  tenantSource?: 'subdomain' | 'path' | 'none';
}

/* ------------------------------------------------------------------ */
/*  Hono generic parameter alias                                       */
/* ------------------------------------------------------------------ */

/**
 * Convenience alias matching Hono's `Env` generic. Used as
 * `new Hono<HonoEnv>()` and in middleware signatures so call sites
 * stay short.
 */
export interface HonoEnv {
  Bindings: AthlyaBindings;
  Variables: AthlyaVariables;
}
