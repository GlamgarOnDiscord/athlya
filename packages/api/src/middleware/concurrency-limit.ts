/**
 * Per-user concurrency limit middleware.
 *
 * Sprint 12 / Slice 12.4 (Epic B4.3) — limits the number of
 * **simultaneous** in-flight requests a single authenticated user
 * can have against the gateway. Different from the sliding-window
 * `rateLimit` (which counts requests per window): concurrency is
 * about "how many requests are being processed RIGHT NOW".
 *
 * Why this matters
 * ----------------
 * A user with 100 in-flight requests amplifies pressure on every
 * downstream dep (Redis, Postgres, Resend, Stripe). The
 * sliding-window already blocks bulk abuse, but a tight loop that
 * starts 50 requests in 1ms followed by another 50 in the next ms
 * could in principle slip through under the budget while doing
 * disproportionate damage. The concurrency cap is the second wall.
 *
 * Algorithm
 * ---------
 * Each authenticated request:
 *   1. INCR `cl:user:<userId>` — atomic counter increment.
 *   2. If the post-increment count exceeds the limit, DECR back
 *      (keep the rest of the budget intact for legitimate clients)
 *      and short-circuit with 429 Problem Details.
 *   3. EXPIRE the counter to a short TTL (30s by default) so an
 *      orphaned counter (e.g. a Worker isolate killed mid-request)
 *      does not lock the user out forever.
 *   4. Run `next()`.
 *   5. In the `finally` arm, DECR back so the counter reflects
 *      truly in-flight requests.
 *
 * Anonymous traffic is NOT subject to this middleware — they fall
 * through the IP-based rate limit instead. This middleware should
 * be mounted AFTER `jwtAuth()` so `authClaims.userId` is populated.
 *
 * Failure mode (issue #65)
 * ------------
 * Staging/production fail-closed when Redis is unreachable — the
 * reservations write surface must not run unbounded. Dev stays
 * fail-open for local iteration without Upstash.
 */

import { buildDependencyUnavailableResponse } from './limiter-guard.js';

import type { Redis } from '@upstash/redis';

/** Default per-user concurrency cap. */
export const DEFAULT_CONCURRENCY_LIMIT = 10;

/** Redis key prefix for the per-user counter. */
export const CONCURRENCY_BUCKET_PREFIX = 'cl:user';

/**
 * Default TTL on the counter (seconds). Acts as a safety net so a
 * Worker isolate killed mid-request (e.g. CPU timeout) does not
 * leave the counter orphaned forever. 30 s is generous: the longest
 * legitimate request in the codebase is the RGPD export (Postgres
 * job, ~10 s), and the Cloudflare Workers CPU cap is 30 s anyway.
 */
export const DEFAULT_TTL_SEC = 30;

/** Problem Details content-type per RFC 9457. */
const PROBLEM_JSON = 'application/problem+json';

/** Options accepted by {@link concurrencyLimit}. */
export interface ConcurrencyLimitOptions {
  /** Maximum simultaneous in-flight requests per user. Default 10. */
  readonly limit?: number;
  /** Counter TTL in seconds. Default 30. */
  readonly ttlSec?: number;
  /**
   * Upstash Redis client.
   *
   * Optional: when omitted, the middleware reads
   * `REDIS_URL`/`REDIS_TOKEN` from `c.env` at first invocation and
   * lazily builds the client via the Upstash SDK. The same client
   * instance is then reused for the lifetime of the Worker
   * isolate (Cloudflare runtime caches the closure).
   *
   * Tests should always inject a fake here so they do not pull in
   * `@upstash/redis` indirectly.
   */
  readonly redis?: Redis;
}

/** Minimal env shape this middleware reads when `redis` is not injected. */
interface ConcurrencyEnv {
  readonly REDIS_URL?: string;
  readonly REDIS_TOKEN?: string;
  /**
   * Sprint 12 / Slice 12.14 — read by the dev bypass below. The
   * middleware skips Redis I/O entirely when `ENVIRONMENT === 'dev'`
   * to mirror the rate-limit and turnstile middlewares.
   */
  readonly ENVIRONMENT?: string;
  /** Optional key prefix for preview-PR isolation (issue #317). */
  readonly REDIS_KEY_PREFIX?: string;
}

/** Minimal context shape this middleware reads. */
interface ConcurrencyContext {
  readonly env: ConcurrencyEnv;
  get(key: string): unknown;
  body(data: string, status: number, headers: Record<string, string>): Response;
}

/** Next handler — Hono's `Promise<void>` shape. */
type ConcurrencyNext = () => Promise<void>;

/** The middleware function signature. */
export type ConcurrencyLimitMiddleware = (
  c: ConcurrencyContext,
  next: ConcurrencyNext,
) => Promise<Response | undefined>;

/* ------------------------------------------------------------------ */
/*  Lazy Redis cache (per-isolate)                                       */
/* ------------------------------------------------------------------ */

/**
 * Module-scope cache keyed by `${REDIS_URL}|${REDIS_TOKEN}`. Mirrors
 * the rate-limiter's caching pattern so the two middlewares share a
 * single Upstash REST client per isolate. We do not import the
 * shared `getOrCreateRedis` from `adapters/deps-cache.ts` here to
 * keep middleware free of adapter-layer dependencies; the cost of a
 * second cache map is one entry per isolate.
 */
const redisCache = new Map<string, Redis>();

async function getCachedRedis(env: ConcurrencyEnv): Promise<Redis> {
  const url = env.REDIS_URL;
  const token = env.REDIS_TOKEN;
  if (url === undefined || url === '' || token === undefined || token === '') {
    throw new Error('concurrencyLimit: REDIS_URL/REDIS_TOKEN missing on env');
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

/** Test seam — flush the per-isolate Redis cache. */
export function __resetConcurrencyLimitRedisCache(): void {
  redisCache.clear();
}

/**
 * Build a per-user concurrency-limit middleware.
 *
 * Usage:
 *
 *     app.use('/v1/reservations/*', jwtAuth());
 *     app.use(
 *       '/v1/reservations/*',
 *       concurrencyLimit({ redis, limit: 10 }),
 *     );
 *
 * Mount AFTER `jwtAuth()` so `authClaims.userId` is set. Anonymous
 * requests skip this middleware (they have no userId to key on).
 */
export function concurrencyLimit(opts: ConcurrencyLimitOptions = {}): ConcurrencyLimitMiddleware {
  const limit = opts.limit ?? DEFAULT_CONCURRENCY_LIMIT;
  const ttlSec = opts.ttlSec ?? DEFAULT_TTL_SEC;
  const injectedRedis = opts.redis;

  return async (c, next) => {
    // Sprint 12 / Slice 12.14 — dev bypass, mirrors the
    // pattern from `worker.ts#guardLimiter` and
    // `middleware/turnstile.ts`. Local dev iterations should
    // not require a real Upstash binding; CI integration tests
    // that point `REDIS_URL` at `.invalid` would otherwise
    // hang on the first INCR.
    const env = c.env;
    if (env.ENVIRONMENT === 'dev') {
      await next();
      return undefined;
    }

    const claims = c.get('authClaims');
    const userId =
      typeof claims === 'object' &&
      claims !== null &&
      typeof (claims as { userId?: unknown }).userId === 'string'
        ? (claims as { userId: string }).userId
        : undefined;

    // Anonymous requests skip the per-user cap — they have no
    // identity to key on. The IP-based rate-limit handles them.
    if (userId === undefined) {
      await next();
      return undefined;
    }

    let redis: Redis;
    try {
      redis = injectedRedis ?? (await getCachedRedis(c.env));
    } catch {
      if (env.ENVIRONMENT === 'dev') {
        await next();
        return undefined;
      }
      const traceId =
        typeof c.get('traceId') === 'string' ? (c.get('traceId') as string) : 'unknown';
      return buildDependencyUnavailableResponse(traceId);
    }

    const globalPrefix = env.REDIS_KEY_PREFIX ?? '';
    const key = `${globalPrefix}${CONCURRENCY_BUCKET_PREFIX}:${userId}`;
    let count: number;
    try {
      count = await redis.incr(key);
    } catch {
      if (env.ENVIRONMENT === 'dev') {
        await next();
        return undefined;
      }
      const traceId =
        typeof c.get('traceId') === 'string' ? (c.get('traceId') as string) : 'unknown';
      return buildDependencyUnavailableResponse(traceId);
    }

    // Best-effort expire so an orphaned counter eventually self
    // heals. We do not await this — a transient EXPIRE failure
    // is not a request-level concern, and it would inflate
    // p99 latency on every request.
    if (count === 1) {
      // Only set the TTL the first time we see the key in
      // this window. Subsequent INCR calls preserve the
      // existing TTL because Redis's INCR does not reset it.
      redis.expire(key, ttlSec).catch(() => {
        // Swallowed — see comment above.
      });
    }

    if (count > limit) {
      // Over the cap. Decrement back so we do not "consume" a
      // slot for a request we are about to refuse, and emit
      // 429 Problem Details. Decrement is best-effort — if
      // it fails the counter will self-heal via the TTL.
      redis.decr(key).catch(() => undefined);

      const traceId =
        typeof c.get('traceId') === 'string' ? (c.get('traceId') as string) : 'unknown';

      const body = JSON.stringify({
        type: 'about:blank',
        title: 'Too Many Requests',
        status: 429,
        code: 'concurrency_limit_exceeded',
        detail: `concurrent request budget (${String(limit)}) exhausted; retry after current request completes`,
        traceId,
      });

      return c.body(body, 429, {
        'content-type': PROBLEM_JSON,
        'retry-after': '1',
      });
    }

    // Within budget. Run the request and ALWAYS decrement on
    // the way out so the counter reflects in-flight reality.
    try {
      await next();
    } finally {
      redis.decr(key).catch(() => undefined);
    }

    return undefined;
  };
}
