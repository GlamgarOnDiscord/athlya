/**
 * Athlya API gateway — Cloudflare Worker entrypoint (task 8.1).
 *
 * What's in this skeleton
 * -----------------------
 *   • A single Hono app typed on {@link HonoEnv} so bindings and
 *     per-request variables stay typechecked at every call site.
 *   • Security headers applied globally via the middleware shipped
 *     by task 8.8 (Req 25.2, 25.4).
 *   • Per-request tracing scaffolding: extracts a 32-hex W3C
 *     trace id from the inbound `traceparent` header when present,
 *     falls back to a UUID v4 otherwise. The id flows to the
 *     structured logger and is echoed on every response.
 *   • Structured JSON logging on every served request (Req 30.4 via
 *     task 13.5). Each line carries `method`, `path`, `status`,
 *     `durationMs`, `traceId`.
 *   • Minimal `/health` endpoint for uptime probes and deployment
 *     smoke tests.
 *   • Problem-Details-shaped error and 404 handlers (RFC 9457).
 *     The 500 branch delegates to the centralised mapper shipped by
 *     task 8.5 (`middleware/problem-details.ts`) — it handles the
 *     `instanceof` dispatch for validation, auth and tenant errors
 *     and enforces the secret-leak guard on the generic fallback.
 *     The 404 handler stays inline (no error-class dispatch needed).
 *   • Default export wiring `fetch` and `scheduled` — `scheduled`
 *     delegates to the outbox drain handler from task 9.3
 *     (Req 16.4).
 *
 * What's NOT in here (yet)
 * ------------------------
 *   • Task 8.2 — JWT auth middleware.
 *   • Task 8.3 — Tenant resolver middleware (`cid` claim → tenantId).
 *   • Task 8.4 — Redis-backed rate limiting middleware.
 *   • Task 8.7 — Per-dependency circuit breaker.
 *   • Task 8.9 — Cloudflare Turnstile on public forms.
 *   • Task 8.10 — Sentry wiring.
 *   • Task 8.11 — Domain route mounts (`/v1/auth`, `/v1/reservations`, …).
 *   • Task 8.12 — Integration tests through Miniflare.
 *
 * How to run / deploy
 * -------------------
 *   Local dev:     `pnpm --filter @athlya/api dev`
 *   Staging:       `pnpm --filter @athlya/api deploy:staging`
 *   Production:    `pnpm --filter @athlya/api deploy:production`
 *
 * The gateway `app` is exported named so later tasks can call
 * `app.route('/v1/auth', authRouter)` on the same instance. The
 * default export is the Cloudflare Worker object Wrangler expects at
 * the `main = "src/worker.ts"` entry.
 */

import { handleUserDeleted, runExportJob } from '@athlya/members';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';

import { buildCascadeDeps } from './adapters/cascade-deps.js';
import { buildExportDeps } from './adapters/export-deps.js';
import { buildStudioSlugResolver } from './adapters/studio-slug-resolver.js';
import { buildDlqRouter } from './admin/dlq-routes.js';
import { buildJwtRotateRouter } from './admin/jwt-rotate-routes.js';
import { handleDlqBatch } from './events/drain-dlq.js';
import { runScheduledDrain } from './events/drain-scheduled.js';
import { buildCronSqlExecutor } from './adapters/cron-sql-executor.js';
import { anonymizeAuditLogViaSql } from './maintenance/anonymize-audit-tx.js';
import { runScheduledRgpdMaintenance } from './maintenance/scheduled-runner.js';
import { createLogger } from './logging.js';
import { jwtAuth } from './middleware/auth.js';
import { tracing } from './middleware/otel.js';
import { registerErrorHandlers } from './middleware/problem-details.js';
import { rateLimit } from './middleware/rate-limit.js';
import { securityHeaders } from './middleware/security-headers.js';
import {
    tenantClaimGuard,
    tenantResolverMiddleware,
} from './middleware/tenant-resolver.js';
import { requireRole } from './routes/helpers.js';
import {
    buildDefaultDeps,
    buildLazyDomainDeps,
    mountDomainRoutes,
    type DomainDeps,
} from './routes/index.js';
import { captureUnhandled, assertSentryDsnIsEu } from './sentry.js';
import { extractTraceparentId, newTraceId } from './tracing/ids.js';


import type { DlqBindings } from './events/drain-dlq.js';
import type {
    ExecutionContext,
    ScheduledEnv,
    ScheduledEvent,
} from './events/drain-scheduled.js';
import type { HonoEnv, AthlyaBindings } from './types.js';
import type {
    AuthUserDeletedEvent,
    MembersExportRequestedEvent,
} from '@athlya/shared/events';
import type { MessageBatch } from '@cloudflare/workers-types';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Problem Details content-type per RFC 9457. */
const PROBLEM_JSON = 'application/problem+json';

/* ------------------------------------------------------------------ */
/*  Sprint 1 — Slice 1.2 hardening constants                          */
/* ------------------------------------------------------------------ */

/**
 * Browser origins allowed to talk to the API in `dev`. Strict
 * whitelist — the previous "reflect any origin" behaviour would
 * have let a malicious local page on a coworker's network make
 * credentialed requests against the dev session (Findings S3-005,
 * S4-003, S4-014). Localhost on http is fine here because dev is
 * not a trust boundary; the same whitelist would NOT pass code
 * review for staging/prod.
 */
const DEV_CORS_ORIGINS: ReadonlySet<string> = new Set([
    'http://localhost:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
]);

/**
 * Hosts the gateway accepts on the `Host` header. The check fires
 * as the very first middleware so a DNS-rebound `Host: evil.com`
 * gets a 421 Misdirected Request (RFC 7540 §9.1.2) before any
 * downstream code runs (Findings S3-003, S4-006, S4-015).
 */
const ALLOWED_HOSTS_PROD: readonly string[] = ['api.athlya.app'];
const ALLOWED_HOSTS_STAGING: readonly string[] = ['staging.api.athlya.app'];
/**
 * In `dev`, allow `localhost` / `127.0.0.1` on any port and
 * Cloudflare's preview deploy domains (`*.workers.dev`). Pattern
 * match instead of static list so local port choices and PR
 * preview hostnames stay frictionless.
 */
const ALLOWED_HOSTS_DEV_PATTERNS: readonly RegExp[] = [
    /^localhost(?::\d+)?$/u,
    /^127\.0\.0\.1(?::\d+)?$/u,
    /^[a-z0-9-]+\.workers\.dev$/u,
];

/**
 * Sprint-10 SP10.1 (Vague 38, critique C2.7) — flag
 * `corsOriginMissingWarned` supprimé. Le flag faisait du dedup
 * per-isolate, ce qui (avec N isolates par PoP Cloudflare) imprimait
 * le warning N fois par cold start au lieu de "une fois". Le dedup
 * était une fausse impression de contrôle. On laisse le warning
 * s'imprimer à chaque request avec ce problème — c'est un bug de
 * config qui mérite d'être bruyant. Tail Workers / Axiom ont leur
 * propre dedup côté ingestion.
 */

/**
 * Module-scope flag for the Sprint-5 SP5.1 Sentry EU residency
 * warning (Vague 33, audit finding S5-010). Same pattern as the
 * CORS_ORIGIN sentinel — emit the warning ONCE per Worker isolate
 * so a misconfigured DSN is loud at boot but does not spam every
 * request.
 */
let sentryRegionWarned = false;

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

/**
 * Options accepted by {@link buildApp}.
 *
 *   • `deps` — custom {@link DomainDeps} bundle to wire into
 *     {@link mountDomainRoutes}. When omitted, {@link buildDefaultDeps}
 *     is called with a placeholder env and its stub bundle is used
 *     instead (every domain method throws `not yet implemented`).
 *     Integration tests pass a `vi.fn()`-backed bundle here so the
 *     route handlers are exercised without a real adapter.
 */
export interface BuildAppOptions {
    readonly deps?: DomainDeps;
}

/**
 * Internal options surface used by the test helper to opt out of
 * mounting `/v1/*` domain routes. NOT exported as part of the public
 * {@link BuildAppOptions} contract.
 *
 * Sprint 11 / Slice 11.1 (critique C2.2) — historically `buildApp`
 * accepted a `skipDomainRoutes` flag directly on its public options.
 * That created a real risk: a developer passing the flag from
 * production code would silently boot a Worker that responds 404 on
 * every `/v1/*` request. The flag is now scoped to a private
 * interface; only the test helper
 * `__tests__/helpers/test-app.ts#buildAppNoDomainRoutes` may set it.
 */
interface BuildAppInternalOptions extends BuildAppOptions {
    readonly skipDomainRoutes?: boolean;
}

/**
 * Construct a fresh Hono instance pre-wired with the gateway's global
 * middleware, the `/health` route and the `/v1/*` domain routers
 * from task 8.11.
 *
 * Extracted as a factory so tests can build isolated app instances
 * and later tasks can compose it with their own routers
 * (`buildApp().route('/v1/auth', authRouter)`).
 */
export function buildApp(options: BuildAppOptions = {}): Hono<HonoEnv> {
    return __buildAppInternal(options);
}

/**
 * Internal entry point shared by {@link buildApp} (production) and
 * the test helper (`__tests__/helpers/test-app.ts`). The
 * `skipDomainRoutes` test seam is gated behind this private export
 * so it cannot leak into application code.
 *
 * Sprint 11 / Slice 11.1 (critique C2.2). The double-underscore
 * prefix signals "test-only" and matches the convention used in the
 * Hono / Vitest ecosystems. End-to-end and integration tests should
 * import this through the helper, not directly.
 */
export function __buildAppInternal(
    options: BuildAppInternalOptions = {},
): Hono<HonoEnv> {
    const app = new Hono<HonoEnv>();

    // 0. Host check — Sprint 1 / Slice 1.2 (Findings S3-003, S4-006,
    //    S4-015). Defense against DNS rebinding and Host-header
    //    spoofing: an attacker who can answer DNS for the victim's
    //    LAN can re-point `api.athlya.app` at their own IP and trick
    //    a Worker preview into responding to a third-party page. We
    //    refuse the request with 421 Misdirected Request (RFC 7540
    //    §9.1.2) before any business code runs. The branch table
    //    below lives at module scope so the lists are visible in code
    //    review.
    //
    //    Real Cloudflare Worker requests always carry a `Host`
    //    header; Hono's in-process `app.request()` test harness does
    //    not, so we fall back to the URL host. Both surfaces yield
    //    the same authority-string and run through the same
    //    whitelist.
    app.use('*', async (c, next) => {
        const fromHeader = c.req.header('host');
        let host: string | undefined;
        if (fromHeader !== undefined && fromHeader !== '') {
            host = fromHeader.toLowerCase();
        } else {
            try {
                host = new URL(c.req.url).host.toLowerCase();
            } catch {
                host = undefined;
            }
        }
        if (host === undefined || host === '') {
            // Sprint-10 SP10.1 (Vague 38, critique C2.6) — log
            // structuré sur 421. C'est un événement sécurité (DNS
            // rebinding / Host header attack) qui mérite une trace.
            console.warn('host check: missing or empty Host header → 421', {
                code: 'host_check_missing',
                method: c.req.method,
                path: new URL(c.req.url).pathname,
            });
            return c.body(null, 421);
        }
        const env = c.env.ENVIRONMENT;
        let allowed = false;
        if (env === 'production') {
            allowed = ALLOWED_HOSTS_PROD.includes(host);
        } else if (env === 'staging') {
            allowed = ALLOWED_HOSTS_STAGING.includes(host);
        } else if (env === 'dev') {
            allowed = ALLOWED_HOSTS_DEV_PATTERNS.some((re) => re.test(host));
        }
        if (!allowed) {
            // Sprint-10 SP10.1 (Vague 38, critique C2.6) — log
            // structuré sur 421. Tentative DNS rebinding / Host
            // spoofing visible dans Tail Workers + Axiom.
            console.warn('host check: Host header mismatch → 421', {
                code: 'host_check_mismatch',
                env,
                rejectedHost: host,
                method: c.req.method,
                path: new URL(c.req.url).pathname,
            });
            return c.body(null, 421);
        }
        await next();
        return undefined;
    });

    // 0.5. Tenant resolver — Sprint 1 / Slice 1.4 (Sprint-1 SP1.5,
    //      audit finding S2-007). Pure, infallible host/path → slug
    //      decoder. Stamps `tenantSlug` (string | undefined) and
    //      `tenantSource` ('subdomain' | 'path' | 'none') onto the
    //      context so downstream middleware (notably the
    //      `tenantClaimGuard()` mounted on `/v1/*` further down) can
    //      cross-check the slug against the JWT `studio` claim.
    //
    //      Mounted EARLY — right after the host check that gates
    //      whitelist + before any business middleware — for two
    //      reasons:
    //        1. The resolver is pure and side-effect-free; running
    //           it cheaply per-request is fine and lets every later
    //           layer (logging, OTel, rate-limit, auth) read the
    //           slug if it ever needs to enrich its observability.
    //        2. The cross-check guard further down depends on
    //           `tenantSlug` being already set; mounting the
    //           resolver here keeps the two factories decoupled and
    //           individually testable.
    //
    //      The resolver does NOT refuse requests — apex hosts
    //      (`api.athlya.app`), IP literals and dev hostnames return
    //      `'none'` legitimately (the mobile API targets the apex,
    //      and dev `localhost:*` exists by design). Refusal logic
    //      lives downstream in `tenantClaimGuard()`.
    app.use('*', tenantResolverMiddleware());

    // 1. Security headers first — they MUST land on every response,
    //    including error responses, so we register the middleware
    //    before anything that can throw.
    app.use('*', securityHeaders());

    // 1.5. CORS middleware — Sprint 1 / Slice 1.2 (Findings S3-005,
    //      S4-003, S4-014). Strict per-environment whitelist:
    //        • `dev`         — fixed localhost set (see `DEV_CORS_ORIGINS`).
    //                          NEVER reflect arbitrary origins, even
    //                          locally; a malicious page on the same
    //                          LAN would otherwise make credentialed
    //                          requests against the dev session.
    //        • `staging`/`production` — `CORS_ORIGIN` env binding is
    //                          REQUIRED. When absent, the callback
    //                          fail-closes (returns `''`, which Hono's
    //                          `cors()` treats as "no
    //                          Access-Control-Allow-Origin echoed")
    //                          and emits a single
    //                          `configuration_error` log line per
    //                          isolate so the misconfiguration is
    //                          loud and early.
    //      Documentation lives on `AthlyaBindings.CORS_ORIGIN` in
    //      `types.ts`; keep the two in sync.
    app.use(
        '*',
        cors({
            origin: (origin, c) => {
                if (origin === null || origin === undefined || origin === '') {
                    return '';
                }
                const athlyaEnv = (c as unknown as { env: AthlyaBindings }).env;
                const env = athlyaEnv.ENVIRONMENT;
                if (env === 'dev') {
                    return DEV_CORS_ORIGINS.has(origin) ? origin : '';
                }
                const allowed = athlyaEnv.CORS_ORIGIN;
                if (allowed === undefined || allowed === '') {
                    // Sprint-10 SP10.1 (C2.7) — pas de dedup
                    // module-scope. Le warning sort à chaque
                    // request avec ce bug de config — bruyant
                    // intentionnellement, dedup côté ingestion
                    // (Tail Workers / Axiom).
                    const logger = (
                        c as { get: (k: string) => unknown }
                    ).get('logger') as
                        | { error: (msg: string, ctx?: unknown) => void }
                        | undefined;
                    const ctx = {
                        code: 'configuration_error',
                        env,
                        binding: 'CORS_ORIGIN',
                    };
                    if (logger !== undefined) {
                        logger.error(
                            'CORS_ORIGIN missing in non-dev env; rejecting all cross-origin requests',
                            ctx,
                        );
                    } else {
                        // The CORS middleware can run before the
                        // logger is set up on `c` — fall back to
                        // the console-backed default so the line
                        // never silently disappears.
                        console.error(
                            'CORS_ORIGIN missing in non-dev env; rejecting all cross-origin requests',
                            ctx,
                        );
                    }
                    return '';
                }
                return origin === allowed ? origin : '';
            },
            allowHeaders: [
                'Content-Type',
                'Authorization',
                'Idempotency-Key',
                'cf-turnstile-token',
            ],
            allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
            credentials: true,
            maxAge: 86400,
        }),
    );

    // 2. Per-request tracing + logger. Sets `traceId`, `logger`, and
    //    `startedAt` on the context BEFORE the handler runs so every
    //    later middleware can read them.
    app.use('*', async (c, next) => {
        const incoming = c.req.header('traceparent') ?? null;
        const traceId = extractTraceparentId(incoming) ?? newTraceId();
        const startedAt = Date.now();
        const logger = createLogger({
            traceId,
            env: c.env.ENVIRONMENT,
        });

        c.set('traceId', traceId);
        c.set('logger', logger);
        c.set('startedAt', startedAt);

        // Echo the trace id back to the caller so distributed traces
        // stitch cleanly. The header name matches common observability
        // tooling conventions.
        c.header('x-trace-id', traceId);

        await next();
    });

    // 2.5. Sprint 1 / Slice 1.2 — fail-loud sentinel for CORS_ORIGIN.
    //      The CORS callback above already fail-closes on a missing
    //      `CORS_ORIGIN` binding (Findings S3-005, S4-003, S4-014),
    //      but a silent fail-close is operationally hostile: the
    //      browser surfaces a generic "CORS error" and Tail Workers
    //      log nothing actionable. This sentinel makes the
    //      misconfiguration explicit. In `staging` / `production`,
    //      a missing or empty `CORS_ORIGIN` produces an RFC 9457
    //      Problem Details 500 (`configuration_error`) so the
    //      smoke-test harness flags the deploy AT BOOT instead of
    //      after a member is locked out of the app.
    //
    //      Mounted AFTER the tracing/logger middleware so
    //      `c.get('logger')` is wired, and BEFORE the rate-limit
    //      guards so we do not waste an Upstash round-trip on a
    //      request we know we will refuse. Pattern mirrors
    //      `middleware/turnstile.ts`'s missing-secret behaviour.
    app.use('*', async (c, next) => {
        const env = c.env.ENVIRONMENT;
        if (env !== 'dev') {
            const allowed = c.env.CORS_ORIGIN;
            if (allowed === undefined || allowed === '') {
                const traceId = c.get('traceId');
                const logger = c.get('logger');
                logger.error('CORS_ORIGIN secret missing — refusing request', {
                    code: 'configuration_error',
                    binding: 'CORS_ORIGIN',
                    env,
                });
                return c.body(
                    JSON.stringify({
                        type: 'about:blank',
                        title: 'Configuration Error',
                        status: 500,
                        detail: 'gateway misconfigured',
                        code: 'configuration_error',
                        traceId,
                    }),
                    500,
                    { 'content-type': PROBLEM_JSON },
                );
            }
        }
        await next();
        return undefined;
    });

    // 2.6. Sprint-5 SP5.1 — Sentry EU residency check (Vague 33,
    //      audit finding S5-010). RGPD Art 44+ requires explicit
    //      safeguards for transfers outside the EU; routing
    //      Sentry events (which carry traceId, request path,
    //      error class, user/studio claims) to a US data centre
    //      without those safeguards is a violation. The check
    //      emits a SINGLE error log per Worker isolate when the
    //      DSN host is not on the EU allow-list — boot is NOT
    //      aborted (the audit's mitigation is "fail loud, not
    //      blocked deploy" so on-call has visibility without
    //      breaking incident response). Op-side mitigation is to
    //      provision an EU DSN via `wrangler secret put SENTRY_DSN`.
    app.use('*', async (c, next) => {
        if (!sentryRegionWarned) {
            const warning = assertSentryDsnIsEu(c.env.SENTRY_DSN);
            if (warning !== null) {
                sentryRegionWarned = true;
                const logger = c.get('logger');
                logger.error(warning, {
                    code: 'configuration_error',
                    binding: 'SENTRY_DSN',
                    env: c.env.ENVIRONMENT,
                });
            } else {
                // Latch even on success so we don't reparse the DSN
                // on every request — the binding never changes
                // mid-isolate.
                sentryRegionWarned = true;
            }
        }
        await next();
    });

    // 3. OTel tracing — build a per-request `TraceSpan` on the
    //    context BEFORE any domain middleware runs so downstream
    //    handlers can call `c.get('span')?.addAttribute(...)` to
    //    enrich the emitted span. Runs AFTER the logging middleware
    //    above so a span-build failure (impossible in practice — the
    //    tracing middleware is infallible) would still log via the
    //    serve-log line. The span is collected and exported after
    //    `next()` returns; see `middleware/otel.ts`.
    app.use('*', tracing());

    // 4. Serve log. Runs AFTER the handler via the `await next()` in
    //    the middleware above — Hono middleware is onion-shaped, so
    //    this block runs when the response is ready.
    app.use('*', async (c, next) => {
        await next();
        const startedAt = c.get('startedAt');
        const logger = c.get('logger');
        const traceId = c.get('traceId');
        const durationMs = Date.now() - startedAt;
        const path = new URL(c.req.url).pathname;
        logger.info('served', {
            method: c.req.method,
            path,
            status: c.res.status,
            durationMs,
            traceId,
        });
    });

    // 5. Rate limiting (Sprint-1 SP1.1 — Req 14.3 100 rps/IP, 14.4
    //    500 rps/user) + a STRICTER override on `/v1/auth/*` so the
    //    sensitive register/login/refresh surface gets a tighter
    //    20 req / 60 s budget. Hono stacks middlewares: matching
    //    routes run BOTH limiters in sequence, so an `/v1/auth/login`
    //    request must clear the strict bucket AND the global one.
    //    The middleware reads `c.env.REDIS_URL` / `REDIS_TOKEN`
    //    (already declared on `AthlyaBindings`) and falls through to
    //    the IP bucket on unauthenticated paths — exactly what we
    //    want here, since auth claims are not yet on the context
    //    when these middlewares run.
    //
    //    Dev bypass: the `dev` environment is intentionally exempt,
    //    matching the precedent set by `middleware/turnstile.ts`.
    //    Local dev iterations would otherwise burn through the
    //    /v1/auth budget on every hot reload, and the test fixtures
    //    point `REDIS_URL` at `.invalid` so a real Upstash call
    //    would hang — neither footgun is worth the safety we'd
    //    gain. Staging and production keep the limiter active; the
    //    audit's findings are scoped to those environments.
    //
    //    Fail-open policy: even on staging/prod, an unreachable
    //    Upstash endpoint must not take the site down. The wrappers
    //    below catch every error raised by the inner limiter BEFORE
    //    it reaches `next()` (typically Upstash transport failures)
    //    and proceed without enforcement. We use a `nextCalled` flag
    //    to differentiate limiter-internal failures (fail-open) from
    //    downstream handler failures (re-throw, caught by the
    //    global mapper). Legitimate 429 denials still flow through
    //    untouched — the wrapped middleware short-circuits with a
    //    `Response` on deny, which we forward verbatim.
    const ipLimiter = rateLimit();
    const authLimiter = rateLimit({ ipLimit: 20, windowSec: 60 });

    const guardLimiter = (
        scope: 'global' | 'auth',
        inner: ReturnType<typeof rateLimit>,
    ) =>
        async (c: Parameters<typeof inner>[0], next: () => Promise<void>) => {
            if ((c.env as AthlyaBindings).ENVIRONMENT === 'dev') {
                await next();
                return undefined;
            }
            let nextCalled = false;
            const wrappedNext = async () => {
                nextCalled = true;
                await next();
            };
            try {
                const result = await inner(c, wrappedNext);
                if (result instanceof Response) return result;
                return undefined;
            } catch (err) {
                if (nextCalled) {
                    // Error came from a downstream handler — let the
                    // global error mapper deal with it.
                    throw err;
                }
                const logger = (
                    c as { get: (k: string) => { warn: (...args: unknown[]) => void } }
                ).get('logger');
                logger.warn('rate-limit unavailable, failing open', {
                    scope,
                    error: err instanceof Error ? err.message : String(err),
                });
                await next();
                return undefined;
            }
        };

    app.use('/v1/*', guardLimiter('global', ipLimiter) as Parameters<typeof app.use>[1]);
    app.use(
        '/v1/auth/*',
        guardLimiter('auth', authLimiter) as Parameters<typeof app.use>[1],
    );

    // 5.5. Sprint 12 / Slice 12.2 (Epic B4.2) — per-mutation
    //      sliding-window rate limits. The global IP+user limits
    //      above defend against bulk abuse; these stricter buckets
    //      defend against targeted abuse of expensive endpoints.
    //
    //      Each limiter shares the same Upstash-backed primitive but
    //      uses its own Redis key namespace via `ipLimit` /
    //      `userLimit` overrides. The middleware reads
    //      `authClaims.userId` from the context — populated by the
    //      domain router's `jwtAuth()` mount earlier in the chain —
    //      so the user bucket wins for authenticated requests.
    //      Anonymous traffic falls through to the IP bucket as
    //      usual.
    //
    //      Budgets:
    //        - POST   /v1/reservations          — 10/min/user (book)
    //        - DELETE /v1/reservations/:id      — 10/min/user (cancel)
    //        - PATCH  /v1/me                    — 5/min/user
    //        - PATCH  /v1/me/consents           — 5/min/user
    //        - POST   /v1/members/me/export     — 1/24h/user
    //
    //      Method-scoped registration: Hono's `app.use('/path', mw)`
    //      runs on every method by default; we wrap each limiter in
    //      a method guard so a benign GET on `/v1/reservations` is
    //      not throttled by the booking budget.
    const reservationLimiter = rateLimit({
        userLimit: 10,
        ipLimit: 10,
        windowSec: 60,
    });
    const profileLimiter = rateLimit({
        userLimit: 5,
        ipLimit: 5,
        windowSec: 60,
    });
    const exportLimiter = rateLimit({
        userLimit: 1,
        ipLimit: 1,
        windowSec: 86400,
    });

    // Method-aware wrapper. Reads `c.req.method` directly on the
    // Hono context (which exposes it natively) and short-circuits
    // to `next()` when the method does not match. Rides on top of
    // `guardLimiter` so per-mutation limits inherit the same dev
    // bypass + fail-open guards as the global and auth ones.
    const guardMutationLimiter = (
        method: 'POST' | 'PATCH' | 'DELETE',
        inner: ReturnType<typeof rateLimit>,
    ) => {
        const guarded = guardLimiter('global', inner);
        return async (
            c: { req: { method: string } },
            next: () => Promise<void>,
        ) => {
            if (c.req.method !== method) {
                await next();
                return undefined;
            }
            return (
                guarded as unknown as (
                    ctx: typeof c,
                    n: typeof next,
                ) => Promise<Response | undefined>
            )(c, next);
        };
    };

    app.use(
        '/v1/reservations',
        guardMutationLimiter(
            'POST',
            reservationLimiter,
        ) as Parameters<typeof app.use>[1],
    );
    app.use(
        '/v1/reservations/:reservationId',
        guardMutationLimiter(
            'DELETE',
            reservationLimiter,
        ) as Parameters<typeof app.use>[1],
    );
    app.use(
        '/v1/me',
        guardMutationLimiter(
            'PATCH',
            profileLimiter,
        ) as Parameters<typeof app.use>[1],
    );
    app.use(
        '/v1/me/consents',
        guardMutationLimiter(
            'PATCH',
            profileLimiter,
        ) as Parameters<typeof app.use>[1],
    );
    app.use(
        '/v1/members/me/export',
        guardMutationLimiter(
            'POST',
            exportLimiter,
        ) as Parameters<typeof app.use>[1],
    );

    // 6. Body-size limit — Sprint 1 / Slice 1.2. Cloudflare's free
    //    Worker plan accepts up to 100 MB request bodies; that is
    //    several orders of magnitude larger than anything our JSON
    //    surface needs. Capping at 256 KiB keeps every legitimate
    //    payload (auth credentials, reservation deltas, billing
    //    selections, audit notes) comfortably below the threshold
    //    while denying body-amplification DDoS attempts that would
    //    otherwise burn CPU-ms on parsing. The cap applies to the
    //    whole `/v1/*` surface; non-versioned routes (/health,
    //    /.well-known/*) are read-only and not exposed to user
    //    input. The 413 response is shaped as RFC 9457 Problem
    //    Details so the failure mode matches the rest of the API.
    app.use(
        '/v1/*',
        bodyLimit({
            maxSize: 256 * 1024,
            onError: (c) => {
                const traceId = (
                    c as { get: (k: string) => string | undefined }
                ).get('traceId');
                const body = JSON.stringify({
                    type: 'about:blank',
                    title: 'Payload Too Large',
                    status: 413,
                    code: 'payload_too_large',
                    traceId,
                });
                return c.body(body, 413, {
                    'content-type': PROBLEM_JSON,
                });
            },
        }),
    );

    // 7. Tenant claim guard — Sprint 1 / Slice 1.4 (Sprint-1 SP1.5,
    //    audit finding S2-007). Refuses requests where the host- or
    //    path-resolved tenant slug does not match the JWT `studio`
    //    claim, with a 404 Problem Details (`code: tenant_mismatch`)
    //    that intentionally does NOT leak the existence of the
    //    other tenant.
    //
    //    Composition contract:
    //      - The slug is read from `tenantSlug` (set by step 0.5).
    //      - The studio claim is read from `authClaims.studioId`,
    //        posted on the context by the inline `jwtAuth()` below.
    //        Each domain router (`/v1/members/*`, `/v1/classes/*`,
    //        …) also calls `jwtAuth()` on its own root — that is
    //        idempotent thanks to the JWKS module-scope cache, so
    //        the duplicate verification has no measurable cost.
    //      - Routes under `/v1/auth/*` are intentionally skipped:
    //        `/v1/auth/login`, `/v1/auth/register` and
    //        `/v1/auth/refresh` are pre-auth (no JWT to challenge,
    //        no claim to compare). The two post-auth subroutes —
    //        `/v1/auth/logout` and `/v1/auth/me delete` — are
    //        identified by `userId` regardless of host: a session
    //        revocation does not need a slug cross-check to be
    //        safe, and exempting the prefix wholesale matches the
    //        principle of least surface change.
    //      - Routes under `/v1/*` other than `/v1/auth/*` are the
    //        standard tenant-scoped surface — they get the full
    //        chain. Path-based `/s/<slug>/...` resolution is
    //        primarily consumed by the Next.js web app's edge
    //        middleware and is NOT mounted on this Worker (the
    //        production routers are all `/v1/*`-prefixed). Should a
    //        future deploy expose `/s/<slug>/v1/...` on this Worker,
    //        a parallel `app.use('/s/*', ...)` mount with the same
    //        wrapper would land the cross-check there too.
    //
    //    Fail-open on DB outage: if the slug → studioId lookup
    //    throws (Postgres unreachable, transient network blip), the
    //    guard logs a warn line and lets the request through.
    //    Tenant isolation is still enforced downstream by the JWT
    //    claim and the RLS policies fed by `withTenant`. This
    //    mirrors the rate-limit fail-open documented in step 5.
    //
    //    Cache: the guard maintains a 60 s TTL Map keyed by
    //    `(env.DB_URL, slug)`, so repeated requests for the same
    //    tenant pay one SELECT every minute regardless of throughput.
    //    The cache lives in `middleware/tenant-resolver.ts`'s module
    //    scope — one entry per tenant-isolate.
    app.use('/v1/*', async (c, next) => {
        // Skip pre-auth `/v1/auth/*` — no Bearer to verify, no
        // claim to compare. The downstream router still mounts its
        // own `jwtAuth()` on the post-auth subroutes (`/logout`,
        // `/me`).
        if (c.req.path.startsWith('/v1/auth/')) {
            await next();
            return undefined;
        }

        // If the resolver did not surface a tenant slug (apex host,
        // IP literal, dev local), there is nothing to cross-check —
        // tenant isolation is enforced downstream by the JWT claim
        // alone (the mobile API targets `api.athlya.app` which
        // resolves to `'none'`). Skipping the inline `jwtAuth()`
        // here also keeps the existing routes/* unit tests passing
        // unchanged: those tests assert per-route 401 envelopes
        // produced by the routers' own `jwtAuth()` mount, and
        // adding a duplicate top-level challenge would replay the
        // same 401 from a different code path.
        const slug = c.get('tenantSlug');
        if (slug === undefined) {
            await next();
            return undefined;
        }

        // Inline jwtAuth challenge so the claim guard below has an
        // `authClaims` to read. The wrapper short-circuits (returns
        // the 401 response) when the JWT is missing or invalid,
        // skipping both the claim guard and the domain router.
        const authResult = await jwtAuth()(c, async () => { });
        if (authResult instanceof Response) {
            return authResult;
        }

        // Build the claim guard with a per-request resolver so the
        // cache namespace tracks `c.env.DB_URL` and the resolver
        // targets the live env. We can't capture `env` at
        // `buildApp()` time because the bindings are not available
        // until a request lands. The factory call itself is cheap
        // (one closure allocation) — the cache it consults is
        // module-scoped in `tenant-resolver.ts`.
        const perRequestGuard = tenantClaimGuard({
            resolveStudioBySlug: buildStudioSlugResolver(c.env),
            cacheNamespace: c.env.DB_URL,
        });
        const guardResult = await perRequestGuard(c, next);
        if (guardResult instanceof Response) {
            return guardResult;
        }
        return undefined;
    });

    /* -------------------------------------------------------------- */
    /*  Routes                                                        */
    /* -------------------------------------------------------------- */

    /**
     * Uptime probe. Returns the environment name, the echoed trace id
     * and the deployed version. Intentionally does NOT touch Redis,
     * Postgres or the queue — Cloudflare's front door pokes this a
     * few times a minute and a dependency failure must not cascade
     * to a red health check.
     */
    app.get('/health', (c) => {
        return c.json({
            status: 'ok' as const,
            environment: c.env.ENVIRONMENT,
            traceId: c.get('traceId'),
            version: c.env.VERSION,
        });
    });

    /**
     * Readiness probe — Sprint 11 / Slice 11.2 (Epic CN.9.4).
     *
     * `/health/ready` differs from `/health` along the canonical
     * Kubernetes liveness/readiness split:
     *
     *   • `/health` (liveness) — answers "is this process alive?".
     *     Cheap, dependency-free. A failure here means the Worker
     *     should be restarted. Cloudflare's edge poker hits this
     *     every few seconds, so we cannot afford a Postgres ping
     *     here.
     *
     *   • `/health/ready` (readiness) — answers "is this process
     *     ready to serve traffic?". Pings Postgres (HTTP driver) and
     *     Redis (Upstash REST). A failure here means the Worker is
     *     up but cannot do useful work; deploy automation should
     *     hold off shifting traffic to a new revision until the
     *     probe goes green. Pattern Stripe / Cloudflare ops use
     *     during canary rollout.
     *
     * Implementation notes:
     *
     *   • Both probes run in parallel via {@link Promise.allSettled}
     *     so a slow Redis does not delay the Postgres signal (and
     *     vice-versa). The handler reports per-dependency status so
     *     ops can see which side is the problem in a single curl.
     *
     *   • A two-second deadline per probe via
     *     `AbortSignal.timeout(2000)` guards against a hung dep
     *     locking up the readiness gate. Cloudflare Workers cap CPU
     *     at 30 s anyway; 2 s is the operational sweet spot for
     *     "give up and report unhealthy" before the deploy
     *     automation bails out.
     *
     *   • Returns `200 OK` with `{ status: 'ready' }` when both deps
     *     answer; `503 Service Unavailable` with a per-dep status
     *     map otherwise. The 503 body is plain JSON (NOT Problem
     *     Details) — readiness probes are infrastructure-level, the
     *     consumer is a deploy script, not an app client.
     *
     *   • In dev / local, missing bindings (`DB_URL` / `REDIS_URL`
     *     blank) collapse to `degraded` rather than a hard 503 so
     *     `pnpm --filter @athlya/api dev` boots cleanly without
     *     real infrastructure. Staging / production fail-CLOSED.
     */
    app.get('/health/ready', async (c) => {
        const env = c.env;
        const isDev = env.ENVIRONMENT === 'dev';
        const traceId = c.get('traceId');

        type ProbeStatus = 'ok' | 'failed' | 'skipped';
        interface ProbeResult {
            readonly status: ProbeStatus;
            readonly latencyMs?: number;
            readonly error?: string;
        }

        async function probeDb(): Promise<ProbeResult> {
            if (env.DB_URL === undefined || env.DB_URL === '') {
                return { status: 'skipped', error: 'DB_URL missing' };
            }
            const started = Date.now();
            try {
                // `pingDbHttp` opens a single-shot Neon HTTP client
                // and runs `SELECT 1`. Bounded with a 2-second
                // deadline via `Promise.race` so a hung Postgres
                // does not lock up the readiness gate.
                const { pingDbHttp } = await import('@athlya/db');
                await Promise.race([
                    pingDbHttp(env.DB_URL),
                    new Promise<never>((_, reject) =>
                        setTimeout(
                            () => reject(new Error('db ping timeout')),
                            2000,
                        ),
                    ),
                ]);
                return {
                    status: 'ok',
                    latencyMs: Date.now() - started,
                };
            } catch (err) {
                return {
                    status: 'failed',
                    latencyMs: Date.now() - started,
                    error:
                        err instanceof Error
                            ? err.message
                            : String(err),
                };
            }
        }

        async function probeRedis(): Promise<ProbeResult> {
            if (
                env.REDIS_URL === undefined ||
                env.REDIS_URL === '' ||
                env.REDIS_TOKEN === undefined ||
                env.REDIS_TOKEN === ''
            ) {
                return {
                    status: 'skipped',
                    error: 'REDIS_URL/TOKEN missing',
                };
            }
            const started = Date.now();
            try {
                // Upstash REST exposes `/ping` directly — cheaper
                // than going through the @upstash/redis client.
                const res = await fetch(`${env.REDIS_URL}/ping`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${env.REDIS_TOKEN}`,
                    },
                    signal: AbortSignal.timeout(2000),
                });
                if (!res.ok) {
                    return {
                        status: 'failed',
                        latencyMs: Date.now() - started,
                        error: `redis http ${res.status}`,
                    };
                }
                return {
                    status: 'ok',
                    latencyMs: Date.now() - started,
                };
            } catch (err) {
                return {
                    status: 'failed',
                    latencyMs: Date.now() - started,
                    error:
                        err instanceof Error
                            ? err.message
                            : String(err),
                };
            }
        }

        const [dbProbe, redisProbe] = await Promise.all([
            probeDb(),
            probeRedis(),
        ]);

        // Dev: any `skipped` is acceptable (= no real binding wired).
        // Staging/prod: `skipped` is a configuration bug → not ready.
        const failed = (p: ProbeResult): boolean =>
            p.status === 'failed' ||
            (!isDev && p.status === 'skipped');

        const ready = !failed(dbProbe) && !failed(redisProbe);
        const httpStatus = ready ? 200 : 503;

        return c.json(
            {
                status: ready
                    ? ('ready' as const)
                    : ('not_ready' as const),
                environment: env.ENVIRONMENT,
                traceId,
                version: env.VERSION,
                checks: {
                    db: dbProbe,
                    redis: redisProbe,
                },
            },
            httpStatus,
        );
    });

    /**
     * Public JWKS endpoint — serves the RS256 verification keys for
     * tokens issued by this Worker. The binding `JWKS_JSON`
     * (a string containing the JSON-serialised JWKS) is injected via
     * `wrangler.toml` vars or `.dev.vars` in local development; a
     * production deploy uses `wrangler secret put JWKS_JSON
     * --env <env>` to avoid leaking the public keys into the
     * dashboard config.
     *
     * The response is cached by verifiers for 10 minutes (see the
     * `auth` middleware's `cacheMaxAge` default), so we set a
     * matching `Cache-Control` value to align with the verifier's
     * expectations.
     *
     * When the binding is absent, we return `404` rather than a
     * fabricated empty JWKS — a verifier that receives `{ keys: [] }`
     * would silently fail every request with `invalid_token`, making
     * the misconfiguration hard to spot. 404 surfaces the error loud
     * and early.
     */
    app.get('/.well-known/jwks.json', (c) => {
        const raw = (c.env as AthlyaBindings & { JWKS_JSON?: string })
            .JWKS_JSON;
        if (raw === undefined || raw === '') {
            return c.notFound();
        }
        return c.body(raw, 200, {
            'content-type': 'application/jwk-set+json',
            'cache-control': 'public, max-age=600',
        });
    });

    /* -------------------------------------------------------------- */
    /*  Error / not-found envelopes                                   */
    /* -------------------------------------------------------------- */

    // 500: delegate to the centralised Problem Details mapper owned
    // by `middleware/problem-details.ts` (task 8.5). The mapper
    // handles the `instanceof` dispatch for `ValidationError`,
    // `MissingAuthClaimsError`, `TenantResourceNotFoundError` and
    // the generic `Error` fallback, logs at the appropriate level
    // (`warn` for 4xx, `error` for 5xx) and — crucially — never
    // leaks `err.message` or `err.stack` on the 500 branch. That
    // secret-leak guard is asserted in
    // `__tests__/problem-details.test.ts` and in `worker.test.ts`.
    //
    // Task 8.11 additionally wires `captureUnhandled` into the
    // 5xx branch so every unhandled 500 is shipped to Sentry with
    // the current request's `traceId` as a tag (Req 30.3). The
    // hook is fire-and-forget — Sentry transport failures never
    // mask the primary response.
    registerErrorHandlers(app, {
        onFiveHundred: (err, c) => {
            // `c` is the live Hono `Context<HonoEnv>`; the Sentry
            // helper duck-types the fields it reads (env, req,
            // traceId), so the cast is type-only.
            return captureUnhandled(
                err,
                c as Parameters<typeof captureUnhandled>[1],
            );
        },
    });

    /* -------------------------------------------------------------- */
    /*  Domain routes (task 8.11)                                     */
    /* -------------------------------------------------------------- */

    // Domain routers are mounted AFTER the global middleware chain
    // (security headers, tracing, serve-log, OTel, error handlers)
    // and BEFORE `app.notFound(...)` so unknown `/v1/*` paths still
    // surface the Problem Details 404 envelope.
    //
    // `buildDefaultDeps` returns a stub bundle whose methods throw
    // `not yet implemented` where an adapter has not shipped — that
    // is fine for task 8.11's scope (wiring), because the
    // integration tests in task 8.12 exercise routing / 4xx
    // envelopes / auth chain only. When a real adapter ships, the
    // stub for that method is replaced in `buildDefaultDeps`.
    //
    // Tests can pass a custom bundle via `options.deps` to exercise
    // the route handlers, or set `options.skipDomainRoutes` to
    // suppress the mount entirely (middleware-chain tests want the
    // chain without the /v1 surface).
    if (options.skipDomainRoutes !== true) {
        if (options.deps !== undefined) {
            // Test path: a fully-built stub bundle was supplied.
            // Mount directly with the provided deps.
            mountDomainRoutes(app, options.deps);
        } else {
            // Production path: Cloudflare Worker bindings are only
            // available on `c.env` at request time, so we mount the
            // domain routes with a lazy deps facade that materialises
            // the real bundle on first use and caches it per-isolate.
            // Every method on the facade reads `latestEnv` — set by
            // the middleware below on the way in — and delegates to
            // the bundle produced by `buildDefaultDeps(env)`. Both
            // `buildDefaultDeps` and the inner adapter factories
            // already memoise their internal state (Drizzle + Redis
            // + JWT keypair) per env reference, so the facade is
            // trivially cheap on the hot path — one hashmap lookup
            // per call.
            let latestEnv: AthlyaBindings | undefined;
            app.use('/v1/*', async (c, next) => {
                latestEnv = c.env;
                await next();
            });
            const lazyDeps = buildLazyDomainDeps(() => {
                if (latestEnv === undefined) {
                    throw new Error(
                        'lazy domain deps: request env not yet captured; this should not happen if the /v1/* middleware ran first',
                    );
                }
                return buildDefaultDeps(latestEnv);
            });
            mountDomainRoutes(app, lazyDeps);
        }
    }

    /* -------------------------------------------------------------- */
    /*  Admin routes — Slice 1.5 (Sprint 1 — SP1.6, audit S2-018)     */
    /* -------------------------------------------------------------- */

    // The DLQ admin router (`packages/api/src/admin/dlq-routes.ts`,
    // hardening task H2) was shipped before this slice but never
    // mounted on the public gateway, so the operator surface
    // documented in `hardening-plan.md` was unreachable in production.
    // Slice 1.5 wires it in with two layers of authentication:
    //
    //   1. `jwtAuth()` on `/admin/*` — populates `authClaims` so the
    //      router's per-route `enforceAdmin()` check has something
    //      to read. Without this, every request would be rejected
    //      with 403 by `enforceAdmin()` regardless of the bearer
    //      token.
    //
    //   2. `requireRole('admin')` on `/admin/*` — defence in depth.
    //      The router already checks `authClaims.role === 'admin'`
    //      internally, but mounting `requireRole('admin')` at the
    //      gateway level means a future admin route that forgets
    //      the per-route guard cannot be hit by a non-admin user
    //      either. Both checks emit RFC 9457 Problem Details 403
    //      bodies, so the duplication is invisible to the client.
    //
    // The router exposes its routes under the literal `/admin/dlq/*`
    // prefix (each handler hard-codes the full path), so we mount
    // it at `app.route('/', router)` rather than at `/admin/dlq` —
    // double-prefixing would shift the routes to `/admin/dlq/admin/dlq/*`
    // and break the contract documented in `dlq-routes.test.ts`.
    app.use('/admin/*', jwtAuth());
    app.use('/admin/*', requireRole('admin'));
    app.route('/', buildDlqRouter() as unknown as Hono<HonoEnv>);

    // Sprint 12 / Slice 12.13 (Epic B3.1) — JWT rotation admin
    // surface. Mounted under the same `/admin/*` chain so it
    // inherits `jwtAuth()` + `requireRole('admin')`. The router
    // already enforces `enforceAdmin()` per-route as defence in
    // depth, mirroring `buildDlqRouter`.
    //
    // Endpoints exposed:
    //   • GET  /admin/jwt/state           — read-only snapshot
    //   • POST /admin/jwt/rotate-prepare  — generate new keypair
    //
    // Operator runbook: `docs/runbooks/rotate-jwt.md`. Audit hook
    // is wired below via the in-memory bridge to the audit log
    // writer once `appendAudit` ships in `auth-deps`. For now the
    // router is mounted without an audit writer; the rotation
    // succeeds and the operator-side wrangler steps remain the
    // single source of truth for the rotation event.
    app.route('/', buildJwtRotateRouter() as unknown as Hono<HonoEnv>);

    // 404: Problem Details envelope, minimal. Task 8.5 will lift the
    // full RFC 9457 shape (type URI catalogue, `instance`, `detail`)
    // into a shared helper.
    app.notFound((c) => {
        const traceId = c.get('traceId');
        const body = {
            type: 'about:blank',
            title: 'Not Found',
            status: 404,
            traceId,
        };
        return c.body(JSON.stringify(body), 404, {
            'content-type': PROBLEM_JSON,
        });
    });

    return app;
}

/**
 * Singleton gateway instance. Named so domain route registration
 * tasks (8.11) can compose mounts onto the shared app:
 *
 *   import { app } from '@athlya/api';
 *   app.route('/v1/reservations', reservationsRouter);
 *
 * Tests build their own app via {@link buildApp} to keep request-
 * level isolation.
 */
export const app = buildApp();

/* ------------------------------------------------------------------ */
/*  Worker default export                                              */
/* ------------------------------------------------------------------ */

/**
 * Cloudflare Worker module shape. Wrangler (`main = "src/worker.ts"`)
 * expects a default export with `fetch` and / or `scheduled`.
 *
 *   • `fetch` delegates to the Hono app's `fetch` so every HTTP
 *     request goes through the middleware chain built above.
 *   • `scheduled` delegates to the drain handler shipped by task 9.3
 *     (Req 16.4). The cron cadence is defined in `wrangler.toml`;
 *     wiring it here keeps the drain operational the moment a cron
 *     trigger is enabled on the Worker.
 *   • `queue` routes incoming queue batches to the right consumer
 *     based on `batch.queue`. Today the only branch is the
 *     `athlya-events-dlq` drain (hardening task H2) — messages are
 *     upserted into a Redis-backed tracker so ops can inspect them
 *     via `/admin/dlq/*`. Additional queues (9.5 Notifications,
 *     future workflows) will add more branches without touching the
 *     envelope above.
 */
const worker = {
    fetch: app.fetch.bind(app),
    scheduled(
        event: ScheduledEvent,
        env: ScheduledEnv,
        ctx: ExecutionContext,
    ): void {
        // Catch infrastructural failures so a crashing cron does not
        // surface as an unhandled rejection. Per-row failures are
        // already swallowed internally by `drainOutbox` and summarised
        // via its `DrainResult`; this catch fires only on
        // `claimBatch` / transaction-level failures.
        const drainTask = runScheduledDrain(env).catch((err: unknown) => {
            // Log through the console-backed default logger — the
            // drain module does not accept `StructuredLogger` shapes
            // and we do not want to convert here; task 8.6 (OTel)
            // will unify the two shapes.
            console.error('[worker] scheduled drain failed', {
                cron: event.cron,
                scheduledTime: event.scheduledTime,
                error: err instanceof Error ? err.message : String(err),
            });
        });
        ctx.waitUntil(drainTask);

        // Sprint 13 / Slice 13.2 (SP6.5 + SP7.6 + SP8.3) — RGPD
        // maintenance cycle. Runs strictly after the outbox drain
        // so a backed-up event queue does not delay user
        // anonymisation. The runner accepts a missing `CRON_DB_URL`
        // gracefully — when the binding is absent (dev / staging
        // first deploy), the cycle skips and logs a warning.
        //
        // The audit-anonymise pass is gated on `CRON_DB_URL`
        // pointing at a role with `BYPASSRLS` (the `users.role`
        // edits cross tenant boundaries). Production wiring uses
        // `athlya_cron` provisioned by migration `0008` (B10);
        // staging falls back to `neondb_owner`.
        const cronExecutor = buildCronSqlExecutor(
            (env as { CRON_DB_URL?: string }).CRON_DB_URL,
        );
        if (cronExecutor !== null) {
            const rgpdTask = runScheduledRgpdMaintenance({
                executeSql: cronExecutor,
                // Sprint 13 / Slice 13.3 (Epic B10.2) — anonymise
                // chaque utilisateur via du SQL pur (pas de
                // SECURITY DEFINER). Le `cronExecutor` doit être
                // connecté avec un role disposant des grants UPDATE
                // sur `audit_log`. Pattern : `athlya_cron` ou — en
                // attendant que migration `0009_audit_cron_grants`
                // soit en place — `neondb_owner` qui bypasse RLS
                // par défaut sur Neon.
                anonymizeOne: async (userId) => {
                    const anonymizedRows = await anonymizeAuditLogViaSql(
                        cronExecutor,
                        userId,
                    );
                    return { anonymizedRows };
                },
            }).catch((err: unknown) => {
                console.error(
                    '[worker] scheduled rgpd maintenance failed',
                    {
                        cron: event.cron,
                        scheduledTime: event.scheduledTime,
                        error:
                            err instanceof Error
                                ? err.message
                                : String(err),
                    },
                );
            });
            ctx.waitUntil(rgpdTask);
        } else {
            console.info(
                '[worker] CRON_DB_URL missing — skipping RGPD maintenance cycle',
                {
                    cron: event.cron,
                    scheduledTime: event.scheduledTime,
                },
            );
        }
    },
    /**
     * Queue consumer dispatch. Cloudflare delivers every queue
     * subscribed via `[[queues.consumers]]` in `wrangler.toml` to
     * this single entry point; `batch.queue` identifies which one
     * produced the batch. We dispatch by queue name and use
     * `ctx.waitUntil` so the isolate stays alive until the handler
     * resolves, even if this method has already returned.
     *
     * Branches:
     *
     *   1. `athlya-events-dlq` (and its per-env equivalents
     *      `athlya-events-staging-dlq` / `athlya-events-production-dlq`)
     *      → DLQ tracker drain (hardening task H2). Per-message
     *      failures are swallowed inside {@link handleDlqBatch}; the
     *      outer catch only fires on infrastructural failures —
     *      Redis unreachable, serialisation panics — and surfaces
     *      them via `console.error` so Tail Workers can alert.
     *
     *   2. Everything else (the main `athlya-events` queue and its
     *      per-env equivalents) → RGPD consumers dispatch
     *      (Slice 1.3 — Sprint 1 — SP1.4, audit findings S5-001 and
     *      S5-002). Each message is parsed for `event.type` and
     *      routed to the matching consumer:
     *        • `auth.user.deleted` → `handleUserDeleted` cascade
     *          (Article 17 — purges reservations, workout_sessions,
     *          push_tokens, R2 avatar; schedules J+30 audit
     *          anonymisation).
     *        • `members.export.requested` → `runExportJob` (Article
     *          15/20 — assembles the ZIP archive, uploads to R2,
     *          stamps the export job `completed`).
     *        • Any other event type is ack'd unconditionally — other
     *          consumers (notifications, billing fan-out, …) will
     *          add their branches without touching this dispatcher's
     *          envelope. Unknown types must NOT be `retry`'d:
     *          Cloudflare's at-least-once redelivery would loop the
     *          message forever and eventually push it to the DLQ for
     *          no reason.
     *
     * Per-message error handling: a thrown error from a known
     * consumer triggers `msg.retry()` so Cloudflare's `max_retries`
     * budget (5, see `wrangler.toml`) eventually shuttles the message
     * to the DLQ; success path acks. We deliberately do NOT ack on
     * the catch path — losing a delete event would leave the user in
     * a half-deleted state.
     */
    queue(
        batch: MessageBatch<unknown>,
        env: AthlyaBindings & DlqBindings,
        ctx: ExecutionContext,
    ): void {
        // The DLQ queues used in dev / staging / production each
        // carry the `-dlq` suffix; matching on the suffix keeps the
        // dispatch loop env-agnostic without enumerating every name.
        const isDlq = batch.queue.endsWith('-dlq');

        if (isDlq) {
            const task = handleDlqBatch(batch, env).catch((err: unknown) => {
                console.error('[worker] dlq handler failed', {
                    queue: batch.queue,
                    error: err instanceof Error ? err.message : String(err),
                });
            });
            ctx.waitUntil(task);
            return;
        }

        // Main events queue branch — RGPD consumers dispatch.
        const task = handleEventsBatch(batch, env).catch((err: unknown) => {
            console.error('[worker] events dispatcher failed', {
                queue: batch.queue,
                error: err instanceof Error ? err.message : String(err),
            });
        });
        ctx.waitUntil(task);
    },
};

export default worker;

/* ------------------------------------------------------------------ */
/*  Events dispatcher (Slice 1.3 — Sprint 1 — SP1.4)                  */
/* ------------------------------------------------------------------ */

/**
 * Narrow envelope shape used by the dispatcher. Cloudflare delivers
 * the message body as `unknown` — the producer (`@athlya/api/events/publish`)
 * always sends a parsed {@link AthlyaEvent}, but defensive narrowing
 * keeps us safe against a malformed third-party producer or a hand-
 * crafted replay during testing.
 */
function readEventEnvelope(
    body: unknown,
): { type: string; id?: string; payload?: unknown } | null {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return null;
    }
    const record = body as Record<string, unknown>;
    const type = record['type'];
    if (typeof type !== 'string' || type.length === 0) return null;
    return {
        type,
        ...(typeof record['id'] === 'string' ? { id: record['id'] } : {}),
        ...(record['payload'] !== undefined
            ? { payload: record['payload'] }
            : {}),
    };
}

/**
 * Dispatch every message of a non-DLQ queue batch.
 *
 * Exported as a free function (rather than inlined in `queue()`) so
 * the integration tests can drive the dispatcher directly with a
 * synthetic `MessageBatch` and assert ack/retry semantics without
 * touching the Hono surface.
 */
export async function handleEventsBatch(
    batch: MessageBatch<unknown>,
    env: AthlyaBindings,
): Promise<void> {
    for (const msg of batch.messages) {
        const envelope = readEventEnvelope(msg.body);
        if (envelope === null) {
            // Malformed payload — ack rather than retry. A producer
            // that emits a non-event onto the events queue is a bug
            // upstream; redelivering it forever would burn retry
            // budget for no reason. The structured log line surfaces
            // the incident in Tail Workers / Logpush.
            console.warn('[worker] events dispatcher: malformed envelope, acking', {
                queue: batch.queue,
                messageId: msg.id,
            });
            msg.ack();
            continue;
        }

        try {
            switch (envelope.type) {
                case 'auth.user.deleted': {
                    // Cast at the boundary — the producer guarantees
                    // the payload shape via `parseEvent`, and the
                    // cascade primitive validates its own inputs at
                    // the SQL layer (zero rows matched ≠ error).
                    await handleUserDeleted(
                        msg.body as AuthUserDeletedEvent,
                        buildCascadeDeps(env),
                    );
                    msg.ack();
                    break;
                }
                case 'members.export.requested': {
                    const event = msg.body as MembersExportRequestedEvent;
                    await runExportJob(
                        event.payload.exportJobId,
                        buildExportDeps(env),
                    );
                    // `runExportJob` returns a discriminated result
                    // (`completed` / `already_completed` / `failed` /
                    // `not_found`) — every kind is a terminal state
                    // the consumer is allowed to ack. The `failed`
                    // branch already stamped `export_jobs.error` so
                    // the user-facing surface surfaces the error;
                    // retrying the queue message would just loop the
                    // failure forever.
                    msg.ack();
                    break;
                }
                default: {
                    // Other consumers (notifications fan-out, billing
                    // analytics, future workflows) live elsewhere or
                    // ship in later slices; ack so the message does
                    // not accumulate redeliveries on the main queue.
                    msg.ack();
                    break;
                }
            }
        } catch (err) {
            // Consumer threw — let Cloudflare retry within the
            // `max_retries = 5` budget. A persistent failure
            // eventually lands on the DLQ, where the H2 drain picks
            // it up and surfaces an alert.
            console.error('[worker] events consumer failed', {
                queue: batch.queue,
                messageId: msg.id,
                eventType: envelope.type,
                eventId: envelope.id,
                error: err instanceof Error ? err.message : String(err),
            });
            msg.retry();
        }
    }
}
