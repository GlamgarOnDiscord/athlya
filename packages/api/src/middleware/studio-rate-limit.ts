/**
 * Per-studio (tenant) burst rate limiter.
 *
 * Sprint 12 / Slice 12.5 (Epic B4.4) — defends the gateway against
 * a studio-wide DDoS / abuse pattern: a misbehaving studio app
 * (e.g. a tablet kiosk on autoreload) could otherwise hit
 * `/v1/check-ins` thousands of times per minute and exhaust shared
 * Postgres / Redis budget for every other tenant on the same
 * Worker isolate. The IP and per-user buckets in
 * `middleware/rate-limit.ts` already exist; this third bucket is
 * the studio-wide cap.
 *
 * Default budget: 1000 requests / 60 s per studio. The number is
 * 10x the per-IP cap because a healthy studio with 10 staff +
 * dozens of members making concurrent bookings should never come
 * close to it; the limit exists for the abuse case, not the
 * normal-load case.
 *
 * Composition contract
 * --------------------
 * Mount AFTER `jwtAuth()` so `authClaims.studioId` is set. Anonymous
 * traffic (login, register) is NOT subject to this middleware
 * because it has no studio identity to key on. The IP bucket from
 * the global `rateLimit` is the primary defence for those paths.
 *
 * Reuses the {@link rateLimitSlidingWindow} primitive from
 * `@athlya/ratelimit` so the algorithm is identical to the per-user
 * bucket; only the key prefix differs.
 */

import { rateLimitSlidingWindow } from '@athlya/ratelimit';

import type { Redis } from '@upstash/redis';

/** Default studio-wide budget: 1000 requests / 60 s. */
export const DEFAULT_STUDIO_LIMIT = 1000;

/** Default window duration in seconds. */
export const DEFAULT_STUDIO_WINDOW_SEC = 60;

/** Redis key prefix for the per-studio bucket. */
export const STUDIO_BUCKET_PREFIX = 'rl:studio';

/** Problem Details content-type per RFC 9457. */
const PROBLEM_JSON = 'application/problem+json';

/** Options accepted by {@link studioRateLimit}. */
export interface StudioRateLimitOptions {
    /** Per-studio request budget. Default 1000. */
    readonly limit?: number;
    /** Window duration in seconds. Default 60. */
    readonly windowSec?: number;
    /**
     * Upstash Redis client.
     *
     * Optional: when omitted, the middleware reads
     * `REDIS_URL`/`REDIS_TOKEN` from `c.env` lazily and caches the
     * client per-isolate. Tests should always inject a fake.
     */
    readonly redis?: Redis;
}

/** Minimal env shape this middleware reads when `redis` is not injected. */
interface StudioRateLimitEnv {
    readonly REDIS_URL?: string;
    readonly REDIS_TOKEN?: string;
    /**
     * Sprint 12 / Slice 12.14 — dev bypass mirror of
     * `concurrency-limit.ts`. Skips Redis I/O when
     * `ENVIRONMENT === 'dev'`.
     */
    readonly ENVIRONMENT?: string;
}

/** Minimal context shape this middleware reads. */
interface StudioRateLimitContext {
    readonly env: StudioRateLimitEnv;
    get(key: string): unknown;
    body(
        data: string,
        status: number,
        headers: Record<string, string>,
    ): Response;
}

type StudioRateLimitNext = () => Promise<void>;

export type StudioRateLimitMiddleware = (
    c: StudioRateLimitContext,
    next: StudioRateLimitNext,
) => Promise<Response | undefined>;

/* ------------------------------------------------------------------ */
/*  Lazy Redis cache                                                    */
/* ------------------------------------------------------------------ */

const redisCache = new Map<string, Redis>();

async function getCachedRedis(env: StudioRateLimitEnv): Promise<Redis> {
    const url = env.REDIS_URL;
    const token = env.REDIS_TOKEN;
    if (
        url === undefined ||
        url === '' ||
        token === undefined ||
        token === ''
    ) {
        throw new Error(
            'studioRateLimit: REDIS_URL/REDIS_TOKEN missing on env',
        );
    }
    const key = `${url}|${token}`;
    let client = redisCache.get(key);
    if (client === undefined) {
        const { Redis: UpstashRedis } = await import('@upstash/redis');
        client = new UpstashRedis({ url, token });
        redisCache.set(key, client);
    }
    return client;
}

export function __resetStudioRateLimitRedisCache(): void {
    redisCache.clear();
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function readStudioId(c: StudioRateLimitContext): string | undefined {
    const raw = c.get('authClaims');
    if (typeof raw !== 'object' || raw === null) return undefined;
    const claims = raw as { studioId?: unknown };
    return typeof claims.studioId === 'string' ? claims.studioId : undefined;
}

function readTraceId(c: StudioRateLimitContext): string {
    const raw = c.get('traceId');
    return typeof raw === 'string' && raw.length > 0 ? raw : 'unknown';
}

/* ------------------------------------------------------------------ */
/*  Factory                                                             */
/* ------------------------------------------------------------------ */

/**
 * Build the per-studio rate-limit middleware.
 *
 * Usage:
 *
 *     app.use('/v1/*', jwtAuth());
 *     app.use('/v1/*', studioRateLimit({ limit: 1000, windowSec: 60 }));
 *
 * Mount AFTER `jwtAuth()` so `authClaims.studioId` is set. Anonymous
 * routes skip this middleware (no studio identity).
 */
export function studioRateLimit(
    opts: StudioRateLimitOptions = {},
): StudioRateLimitMiddleware {
    const limit = opts.limit ?? DEFAULT_STUDIO_LIMIT;
    const windowSec = opts.windowSec ?? DEFAULT_STUDIO_WINDOW_SEC;
    const injectedRedis = opts.redis;

    if (!Number.isFinite(limit) || limit <= 0) {
        throw new RangeError(
            `studioRateLimit: limit must be > 0, got ${String(limit)}`,
        );
    }
    if (!Number.isFinite(windowSec) || windowSec <= 0) {
        throw new RangeError(
            `studioRateLimit: windowSec must be > 0, got ${String(windowSec)}`,
        );
    }

    return async (c, next) => {
        // Sprint 12 / Slice 12.14 — dev bypass, mirrors the
        // pattern from `worker.ts#guardLimiter`,
        // `middleware/concurrency-limit.ts` and
        // `middleware/turnstile.ts`. Local dev iterations and
        // integration tests do not exercise a real Upstash
        // backend; this short-circuit avoids hanging on `.invalid`
        // hostnames.
        const env = c.env as StudioRateLimitEnv;
        if (env.ENVIRONMENT === 'dev') {
            await next();
            return undefined;
        }

        const studioId = readStudioId(c);
        if (studioId === undefined) {
            // Anonymous request — fall through to the global IP /
            // user buckets in `middleware/rate-limit.ts`. The
            // studio bucket is a tenant-level concept; routes that
            // can be reached without a verified `studioId` claim
            // (login, register, refresh) keep the IP-bucket as
            // their primary defence.
            await next();
            return undefined;
        }

        let redis: Redis;
        try {
            redis = injectedRedis ?? (await getCachedRedis(c.env));
        } catch {
            // Misconfiguration. Fail-open: per-IP and per-user
            // buckets remain active.
            await next();
            return undefined;
        }

        const key = `${STUDIO_BUCKET_PREFIX}:${studioId}`;
        let decision: Awaited<
            ReturnType<typeof rateLimitSlidingWindow>
        >;
        try {
            decision = await rateLimitSlidingWindow(
                { redis },
                key,
                limit,
                windowSec,
            );
        } catch {
            // Upstash unreachable — fail-open like the per-IP /
            // per-user buckets do.
            await next();
            return undefined;
        }

        if (decision.kind === 'deny') {
            const traceId = readTraceId(c);
            const retryAfter = Math.max(1, decision.retryAfterSec);
            const body = JSON.stringify({
                type: 'about:blank',
                title: 'Too Many Requests',
                status: 429,
                code: 'studio_rate_limit_exceeded',
                detail: `studio request budget (${String(limit)} per ${String(windowSec)}s) exhausted`,
                traceId,
            });
            return c.body(body, 429, {
                'content-type': PROBLEM_JSON,
                'retry-after': String(retryAfter),
            });
        }

        await next();
        return undefined;
    };
}
