/**
 * Global rate-limit middleware (task 8.4).
 *
 * Satisfies Requirements 14.3 and 14.4:
 *
 *   • 14.3 — The API_Gateway SHALL respond with HTTP 429 and a
 *            `Retry-After` header when more than 100 requests per
 *            second are observed for a given client IP.
 *   • 14.4 — The API_Gateway SHALL respond with HTTP 429 and a
 *            `Retry-After` header when more than 500 requests per
 *            second are observed for a given authenticated user.
 *
 * ### Upstream / downstream
 *
 *   • Upstream primitive: {@link rateLimitSlidingWindow} from
 *     `@athlya/ratelimit` (extracted in hardening H5 from its original
 *     home at `packages/api/src/ratelimit.ts`). Its sliding-window
 *     algorithm carries the exactness property (P8) for free; we only
 *     pick the key, the limit and the window here.
 *   • Downstream wiring: task 8.11 mounts this middleware on the
 *     gateway `app`. The file exports a factory so mounting is the
 *     caller's decision — this module never touches the global `app`.
 *
 * ### Keying policy
 *
 * Per-user quotas supersede per-IP quotas: an authenticated request
 * carrying a valid `authClaims.userId` is keyed by user id and gets
 * the generous 500 rps bucket, never the stricter 100 rps IP bucket.
 * Without claims we fall back to the IP bucket.
 *
 * IP derivation follows Cloudflare's canonical precedence:
 *   1. `CF-Connecting-IP` — set by Cloudflare's edge on every inbound
 *      request. This is the source of truth when the Worker runs
 *      behind Cloudflare (i.e. production).
 *   2. `X-Forwarded-For` first token — honoured when `CF-Connecting-IP`
 *      is absent (local dev, tests, non-CF deployments). We take the
 *      FIRST IP in the comma-separated list per the proxy convention:
 *      it is the originating client; later entries were added by
 *      intermediate proxies.
 *   3. The string `"unknown"` — last-resort bucket so a peer that
 *      spoofs away every header still shares one global pool rather
 *      than bypassing the limiter entirely.
 *
 * ### Deny response
 *
 * On a `deny` decision we short-circuit with an RFC 9457 Problem
 * Details envelope (`application/problem+json`) matching the 404 /
 * 500 shape emitted by `worker.ts`:
 *
 *   ```json
 *   { "type": "about:blank",
 *     "title": "Too Many Requests",
 *     "status": 429,
 *     "traceId": "<uuid>" }
 *   ```
 *
 * The `Retry-After` header is the integer seconds the limiter reports,
 * clamped to a floor of 1 — `Retry-After: 0` is technically legal
 * but tells misbehaving clients they may retry immediately, which
 * defeats the purpose of the header.
 *
 * ### Redis client caching
 *
 * The Upstash client is lazily instantiated on the first request and
 * cached at module scope keyed on `REDIS_URL`. This mirrors the
 * `dbPoolCache` pattern in `middleware/tenant.ts`: a single Worker
 * isolate can legitimately serve the dev, staging and production
 * environments during a preview build and the credentials differ per
 * env, so a keyed cache avoids cross-env pool sharing while still
 * saving a `new Redis(...)` allocation on every request.
 */

import { rateLimitSlidingWindow } from '@athlya/ratelimit';
import { Redis } from '@upstash/redis';

import type { RateLimitDecision } from '@athlya/ratelimit';

/* ------------------------------------------------------------------ */
/*  Policy defaults                                                    */
/* ------------------------------------------------------------------ */

/**
 * Per-IP quota in requests per window.
 *
 * Sprint-10 SP10.1 (Vague 38, critique C1.2) — bumped from 100/s to
 * 1000/60s. The previous 100/s in a 1-second sliding-log window
 * produced 429 false positives on legitimate users because:
 *   - SPA hydration can fire 30-50 API calls in the first 200ms.
 *   - Multi-tab usage on the same IP compounds the burst.
 *   - The sliding-log algorithm allocates the entire 1-second budget
 *     to the first burst, leaving the remaining 800ms starved.
 *
 * Industry references: Stripe uses 60s windows. Cloudflare AI
 * Gateway uses 60s. Netflix uses larger budgets still. 1000 req/min
 * (~17/s sustained, 500 burstable) matches a fitness-app use case
 * comfortably while still rejecting scripted attack volumes.
 */
export const DEFAULT_IP_LIMIT = 1000;

/**
 * Per-user quota in requests per window.
 *
 * Same Sprint-10 bump rationale — 500/s in a 1s window was a
 * footgun. 5000/min ≈ 83/s sustained, plenty for an authenticated
 * client that polls a few endpoints in parallel without ever
 * hitting the limit during normal use.
 */
export const DEFAULT_USER_LIMIT = 5000;

/**
 * Window size in seconds.
 *
 * Sprint-10 SP10.1 (Vague 38, critique C1.2) — bumped from 1s to
 * 60s. The 1s window plus sliding-log algorithm together caused a
 * burst at the start of the window to consume the entire budget.
 * 60s is the industry standard (see DEFAULT_IP_LIMIT comment for
 * references) and absorbs UI bursts gracefully.
 */
export const DEFAULT_WINDOW_SEC = 60;

/** Key prefix for the IP bucket. Short to minimise Upstash payload. */
export const IP_BUCKET_PREFIX = 'rl:ip';

/** Key prefix for the user bucket. */
export const USER_BUCKET_PREFIX = 'rl:user';

/** Problem Details content-type per RFC 9457. */
const PROBLEM_JSON = 'application/problem+json';

/** Bucket used when no IP can be derived from the request headers. */
const UNKNOWN_IP_BUCKET = 'unknown';

/* ------------------------------------------------------------------ */
/*  Options                                                            */
/* ------------------------------------------------------------------ */

/**
 * Factory options for {@link rateLimit}. Every field is optional; the
 * middleware falls back to the production defaults above when a field
 * is absent.
 */
export interface RateLimitOptions {
    /** Override limit per authenticated user. Default 500. */
    readonly userLimit?: number;
    /** Override limit per IP. Default 100. */
    readonly ipLimit?: number;
    /** Window in seconds. Default 1. */
    readonly windowSec?: number;
    /**
     * Inject a Redis client (used by tests). Production wiring leaves
     * this `undefined` so the factory lazily builds one from
     * `c.env.REDIS_URL` / `c.env.REDIS_TOKEN` on first use.
     */
    readonly redis?: Redis;
}

/* ------------------------------------------------------------------ */
/*  Framework-free context shape                                       */
/* ------------------------------------------------------------------ */

/**
 * Subset of `authClaims` the limiter looks at.
 *
 * The full shape lives in `@athlya/db`'s {@link TenantClaims}; we only
 * care whether a userId exists here. Typing the field as
 * `string | undefined` keeps the middleware honest when the auth
 * middleware did not run (public routes) — the claims will be
 * `undefined` and we will fall through to the IP branch.
 */
interface LimiterAuthClaims {
    readonly userId?: string;
}

/**
 * Minimal request-header reader. Hono's `c.req.header(name)` matches
 * this shape. The method returns `string | undefined` so absent
 * headers are distinguishable from empty ones.
 */
interface RateLimitRequest {
    header(name: string): string | undefined;
}

/**
 * Minimal Worker bindings the middleware touches. The full
 * `AthlyaBindings` surface from `types.ts` is broader but the limiter
 * only reads the Upstash URL / token pair.
 */
interface RateLimitEnv {
    readonly REDIS_URL: string;
    readonly REDIS_TOKEN: string;
}

/**
 * Framework-free context shape accepted by {@link rateLimit}.
 *
 * Hono's `Context` satisfies this interface by structural typing. We
 * keep it here (rather than importing Hono types) so the module stays
 * framework-agnostic, the same way `security-headers.ts` does.
 *
 * `get(key)` returns `unknown` on purpose: the limiter treats anything
 * that is not a non-empty string userId as "unauthenticated" and
 * falls back to the IP bucket. That matches how `middleware/tenant.ts`
 * handles the same key.
 */
export interface RateLimitContext {
    /** Cloudflare Worker `env` narrowed to the fields we read. */
    readonly env: RateLimitEnv;
    /** Request metadata — we only need the header reader. */
    readonly req: RateLimitRequest;
    /** Reads a variable set by upstream middleware (`authClaims`, `traceId`). */
    get(key: string): unknown;
}

/* ------------------------------------------------------------------ */
/*  Module-scope Redis cache                                           */
/* ------------------------------------------------------------------ */

/**
 * Upstash clients keyed by `REDIS_URL`. See file header for the
 * multi-env rationale. A `Map` is used (rather than a plain object)
 * so a connection URL containing reserved property names cannot
 * poison the cache, and so tests can clear it via
 * {@link __resetRateLimitRedisCache}.
 */
const redisCache = new Map<string, Redis>();

function getCachedRedis(env: RateLimitEnv): Redis {
    const url = env.REDIS_URL;
    const cached = redisCache.get(url);
    if (cached !== undefined) {
        return cached;
    }
    const client = new Redis({ url, token: env.REDIS_TOKEN });
    redisCache.set(url, client);
    return client;
}

/**
 * Test-only seam that clears the module-level Redis cache so
 * consecutive tests can swap in fresh fakes without residue.
 */
export function __resetRateLimitRedisCache(): void {
    redisCache.clear();
}

/* ------------------------------------------------------------------ */
/*  Key derivation                                                     */
/* ------------------------------------------------------------------ */

/**
 * Extract the client IP from the request headers following
 * Cloudflare's convention. Exported for tests and observability.
 *
 *   1. `CF-Connecting-IP` wins when present. It is injected by
 *      Cloudflare's edge and is not forgeable from outside the
 *      network.
 *   2. Otherwise the FIRST token of `X-Forwarded-For` (proxy chain:
 *      client → proxy1 → proxy2).
 *   3. Otherwise the string {@link UNKNOWN_IP_BUCKET} so unknown
 *      peers share one bucket rather than escaping the limiter.
 *
 * A blank header value (`""` / whitespace-only) is treated as absent
 * so a misbehaving proxy cannot split the IP bucket.
 */
export function deriveClientIp(req: RateLimitRequest): string {
    const cfIp = req.header('CF-Connecting-IP');
    if (typeof cfIp === 'string' && cfIp.trim().length > 0) {
        return cfIp.trim();
    }

    const xff = req.header('x-forwarded-for');
    if (typeof xff === 'string' && xff.trim().length > 0) {
        const firstToken = xff.split(',')[0];
        if (firstToken !== undefined) {
            const trimmed = firstToken.trim();
            if (trimmed.length > 0) {
                return trimmed;
            }
        }
    }

    return UNKNOWN_IP_BUCKET;
}

/**
 * Read `authClaims.userId` from the context, returning `undefined`
 * when the middleware stack has not authenticated the request.
 *
 * Defensive: accepts any shape for the claims (the context type is
 * framework-free and `get` returns `unknown`), but only treats the
 * value as a real userId when it is a non-empty string. Anything else
 * — `null`, missing field, empty string — falls back to the IP
 * branch.
 */
function readUserId(c: RateLimitContext): string | undefined {
    const raw = c.get('authClaims');
    if (raw === undefined || raw === null || typeof raw !== 'object') {
        return undefined;
    }
    const claims = raw as LimiterAuthClaims;
    if (typeof claims.userId !== 'string' || claims.userId.length === 0) {
        return undefined;
    }
    return claims.userId;
}

/**
 * Read the request trace id written by the tracing middleware in
 * `worker.ts`. Falls back to `'unknown'` if the middleware chain did
 * not set one — the limiter still emits a valid Problem Details body
 * either way.
 */
function readTraceId(c: RateLimitContext): string {
    const raw = c.get('traceId');
    return typeof raw === 'string' && raw.length > 0 ? raw : 'unknown';
}

/* ------------------------------------------------------------------ */
/*  Middleware                                                         */
/* ------------------------------------------------------------------ */

/**
 * Next-handler contract. Hono's `Next` matches this shape exactly.
 */
type RateLimitNext = () => Promise<void>;

/**
 * Middleware handler signature. Returning `Response` short-circuits
 * the chain (Hono's compose loop promotes a returned Response to the
 * request response); returning `undefined` (via `await next()`) lets
 * the request continue through the pipeline.
 */
export type RateLimitMiddleware = (
    c: RateLimitContext,
    next: RateLimitNext,
) => Promise<Response | undefined>;

/**
 * Build the problem-details 429 response. Extracted so the shape
 * stays consistent across every deny path and so tests can assert on
 * it without coupling to the factory internals.
 */
function buildDenyResponse(
    decision: Extract<RateLimitDecision, { kind: 'deny' }>,
    traceId: string,
): Response {
    // Floor at 1 — `Retry-After: 0` is legal but tells clients to
    // retry immediately, which defeats the purpose of emitting it at
    // all. The limiter already clamps to `[1, windowSec]` but belt-
    // and-braces defence is cheap.
    const retryAfterSec = Math.max(
        1,
        Math.floor(Number.isFinite(decision.retryAfterSec) ? decision.retryAfterSec : 1),
    );

    const body = JSON.stringify({
        type: 'about:blank',
        title: 'Too Many Requests',
        status: 429,
        traceId,
    });

    return new Response(body, {
        status: 429,
        headers: {
            'content-type': PROBLEM_JSON,
            'retry-after': String(retryAfterSec),
        },
    });
}

/**
 * Build the global rate-limit middleware.
 *
 * Behaviour per request:
 *
 *   1. Derive the bucket: authenticated ⇒ `rl:user:<userId>`,
 *      otherwise `rl:ip:<ip>` with IP resolved via
 *      {@link deriveClientIp}.
 *   2. Evaluate the sliding window through the cached Upstash client
 *      (or the injected test double).
 *   3. On `allow`, write `X-RateLimit-Limit` / `X-RateLimit-Remaining`
 *      if the context exposes a `header` setter, then call `next()`.
 *      The informational headers are nice-to-have and missing them
 *      does not violate Req 14.3 / 14.4.
 *   4. On `deny`, short-circuit with a 429 Problem Details body and
 *      `Retry-After: <retryAfterSec>`. `next()` is NOT invoked —
 *      the downstream handler must never see a denied request.
 *
 * The factory returns a Hono-compatible middleware. Mounting is the
 * caller's responsibility (task 8.11 does it on the gateway app).
 */
export function rateLimit(opts: RateLimitOptions = {}): RateLimitMiddleware {
    const userLimit = opts.userLimit ?? DEFAULT_USER_LIMIT;
    const ipLimit = opts.ipLimit ?? DEFAULT_IP_LIMIT;
    const windowSec = opts.windowSec ?? DEFAULT_WINDOW_SEC;
    const injectedRedis = opts.redis;

    if (!Number.isFinite(userLimit) || userLimit <= 0) {
        throw new RangeError(`rateLimit: userLimit must be > 0, got ${String(userLimit)}`);
    }
    if (!Number.isFinite(ipLimit) || ipLimit <= 0) {
        throw new RangeError(`rateLimit: ipLimit must be > 0, got ${String(ipLimit)}`);
    }
    if (!Number.isFinite(windowSec) || windowSec <= 0) {
        throw new RangeError(`rateLimit: windowSec must be > 0, got ${String(windowSec)}`);
    }

    return async (c, next) => {
        const redis = injectedRedis ?? getCachedRedis(c.env);

        const userId = readUserId(c);
        const isAuthenticated = userId !== undefined;
        const key = isAuthenticated
            ? `${USER_BUCKET_PREFIX}:${userId}`
            : `${IP_BUCKET_PREFIX}:${deriveClientIp(c.req)}`;
        const limit = isAuthenticated ? userLimit : ipLimit;

        const decision = await rateLimitSlidingWindow(
            { redis },
            key,
            limit,
            windowSec,
        );

        if (decision.kind === 'deny') {
            const traceId = readTraceId(c);
            return buildDenyResponse(decision, traceId);
        }

        // Allow: optionally surface the bucket state on the outgoing
        // response. Hono's `Context.header(k, v)` is the standard
        // setter; duck-typing lets non-Hono callers skip the headers
        // without crashing. Nice-to-have per the task spec, not
        // required by Req 14.3 / 14.4.
        const maybeHeader = (c as { header?: (k: string, v: string) => void }).header;
        if (typeof maybeHeader === 'function') {
            maybeHeader.call(c, 'X-RateLimit-Limit', String(limit));
            maybeHeader.call(c, 'X-RateLimit-Remaining', String(decision.remaining));
        }

        await next();
        return undefined;
    };
}
