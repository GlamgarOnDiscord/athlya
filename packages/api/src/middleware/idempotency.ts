/**
 * Idempotency middleware for mutation routes.
 *
 * Wraps mutation handlers so retries of the same `(Idempotency-Key,
 * user_id)` pair replay the stored response instead of re-executing the
 * mutation. Implements Requirements 20.1 and 20.2:
 *
 *   • 20.1 — A mutation request carrying an `Idempotency-Key` matching a
 *            previously applied request SHALL return the stored response
 *            without re-executing the mutation.
 *   • 20.2 — Key bindings are persisted for at least 24 hours
 *            (`ttlSec = 86_400` by default).
 *
 * The middleware layers on top of `@athlya/db/idempotency`
 * (`lookup` / `store`, task 2.5) which owns the SQL and the race-safe
 * `INSERT … ON CONFLICT DO NOTHING` semantics. We only do HTTP-layer
 * work here: method filtering, header validation, context lookup,
 * response capture and logging.
 *
 * Why 2xx *and* 409 are cached
 * ----------------------------
 * The Reservations service uses 409 Conflict as the canonical reply for
 * "this mutation has already been applied" — see design §E2 Double
 * booking. Caching 409 lets clients retrying after an ambiguous network
 * drop observe the exact same body on every replay, matching the wire
 * contract assumed by the Mobile_App drain loop (Requirement 19.4).
 *
 * Why storage failures are swallowed
 * ----------------------------------
 * The primary response is what the client sees. Losing an idempotency
 * row means the next retry will execute the mutation again, which is
 * safe because every mutation in the domain has its own unique
 * constraint or state-machine guard (design §E2, §P2). Letting a
 * transient Postgres hiccup poison an otherwise-successful 201 would
 * be a worse failure mode, so we log and move on.
 */

import { lookup, store } from '@athlya/db/idempotency';

import type { AthlyaDb, AthlyaTx } from '@athlya/db/client';
import type { Context, MiddlewareHandler } from 'hono';

/** Default retention — exactly 24 h, the minimum mandated by Req 20.2. */
export const DEFAULT_IDEMPOTENCY_TTL_SEC = 24 * 60 * 60;

/** HTTP methods the middleware inspects. Read-only verbs pass through. */
const DEFAULT_MUTATION_METHODS: ReadonlySet<string> = new Set([
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
]);

/** Maximum accepted header length. Mirrors the DB helper's bound. */
const KEY_MAX_LENGTH = 255;

/**
 * Minimal logger shape. Defaults to `console` so production deploys can
 * inject an Axiom/OTel-aware logger without forcing a dependency.
 */
export interface IdempotencyLogger {
    warn: (msg: string, extra?: Record<string, unknown>) => void;
    error: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface IdempotencyMiddlewareDeps {
    /**
     * Drizzle handle — typically the app-scoped {@link AthlyaDb} client
     * from `createDb()`. A {@link AthlyaTx} is accepted too so callers
     * can share a transaction with a surrounding scope during tests.
     */
    readonly db: AthlyaDb | AthlyaTx;
    /** Retention in seconds. Defaults to {@link DEFAULT_IDEMPOTENCY_TTL_SEC}. */
    readonly ttlSec?: number;
    /** HTTP methods considered mutations. Defaults to POST/PUT/PATCH/DELETE. */
    readonly mutationMethods?: ReadonlySet<string>;
    /** Swappable logger for warn/error paths. Defaults to `console`. */
    readonly logger?: IdempotencyLogger;
}

/**
 * Hono environment contract. The auth middleware (task 8.2) is expected
 * to set `userId` on the context before this middleware runs on any
 * mutation route, so it is declared as required here. Downstream Hono
 * apps that mix in additional variables stay assignable because Hono's
 * `Env.Variables` is intersected at use-site.
 */
export interface IdempotencyEnv {
    Variables: {
        userId: string;
    };
}

/**
 * Problem Details envelope shape used on the 400 path. We emit the
 * minimum required by RFC 7807 / Req 14.6; the global error middleware
 * (task 8.5) will decorate every other error. The middleware itself
 * short-circuits with 400 so a malformed header never reaches the
 * domain service.
 */
interface IdempotencyProblem {
    type: string;
    title: string;
    status: 400;
    detail: string;
}

/**
 * Build the idempotency middleware.
 *
 * Behaviour:
 *   1. Non-mutation methods (GET, HEAD, OPTIONS) pass through unchanged.
 *   2. Requests without an `Idempotency-Key` header pass through too —
 *      the header is explicitly optional per Req 20.3.
 *   3. A key longer than 255 chars or empty responds with `400
 *      invalid_idempotency_key` without invoking the handler.
 *   4. `userId` is read from `c.get('userId')`. Its absence is a
 *      programming error (auth middleware missed this route) and throws.
 *   5. On a fresh, non-expired cache hit, the stored body and status are
 *      replayed via `c.json()`. The downstream handler is NOT invoked,
 *      satisfying Req 20.1.
 *   6. On a miss, `next()` runs; if the response status is 2xx or 409
 *      and the body is JSON, we store `{ body, statusCode }` with the
 *      configured TTL so the next retry replays verbatim.
 *   7. Storage failures are caught and logged — they never mask the
 *      user-visible response.
 */
export function idempotencyMiddleware(
    deps: IdempotencyMiddlewareDeps,
): MiddlewareHandler<IdempotencyEnv> {
    const ttlSec = deps.ttlSec ?? DEFAULT_IDEMPOTENCY_TTL_SEC;
    const methods = deps.mutationMethods ?? DEFAULT_MUTATION_METHODS;
    const logger: IdempotencyLogger = deps.logger ?? {
        warn: (msg, extra) => {
            console.warn(`[idempotency] ${msg}`, extra ?? {});
        },
        error: (msg, extra) => {
            console.error(`[idempotency] ${msg}`, extra ?? {});
        },
    };

    return async (c, next) => {
        const method = c.req.method.toUpperCase();
        if (!methods.has(method)) {
            await next();
            return;
        }

        const rawKey = c.req.header('Idempotency-Key');
        if (rawKey === undefined || rawKey === null) {
            await next();
            return;
        }

        // Trim a single leading/trailing whitespace run — the HTTP spec
        // forbids it but header middleboxes occasionally add one and
        // silently accepting a bogus key would split the cache.
        const key = rawKey.trim();
        if (key.length === 0 || key.length > KEY_MAX_LENGTH) {
            return c.json<IdempotencyProblem>(
                {
                    type: 'about:blank',
                    title: 'invalid_idempotency_key',
                    status: 400,
                    detail:
                        key.length === 0
                            ? 'Idempotency-Key must be a non-empty string'
                            : `Idempotency-Key must be ≤ ${String(KEY_MAX_LENGTH)} characters`,
                },
                400,
            );
        }

        const userId = c.get('userId');
        if (typeof userId !== 'string' || userId.length === 0) {
            // Programmer error: the auth middleware should have set
            // `userId` before this runs on a mutation route. Throwing
            // bubbles up to the global error handler which will log to
            // Sentry and respond 500 — much better than a silent 401
            // stand-in, which would lie about the root cause.
            throw new Error(
                '[idempotency] userId missing from Hono context; ' +
                'wire auth middleware before idempotencyMiddleware',
            );
        }

        // --- Lookup path (Req 20.1) -------------------------------------
        let hit = null;
        try {
            hit = await lookup(deps.db, key, userId);
        } catch (err) {
            // A lookup failure must not mask the mutation — degrade to
            // "miss" so the handler still runs. The operator learns
            // about it through the log; repeated entries should trigger
            // an Axiom alert.
            logger.error('lookup failed', {
                key,
                userId,
                error: errorToDetail(err),
            });
        }

        if (hit !== null) {
            return c.json(hit.response, statusCodeOf(hit.statusCode));
        }

        // --- Execute path ------------------------------------------------
        await next();

        const status = c.res.status;
        if (!isCacheableStatus(status)) {
            return;
        }

        const body = await readJsonBody(c, logger);
        if (body === null) {
            return;
        }

        try {
            await store(
                deps.db,
                key,
                userId,
                { body, statusCode: status },
                ttlSec,
            );
        } catch (err) {
            logger.warn('store failed; continuing without cache', {
                key,
                userId,
                status,
                error: errorToDetail(err),
            });
        }
        return;
    };
}

/**
 * Narrow Hono's `StatusCode` slot to the numeric subtype it accepts at
 * runtime. The DB column is a `smallint` in `[100, 599]` (enforced by
 * `validateResponse` in the helper), so any surviving number is safe
 * for `c.json`.
 */
function statusCodeOf(
    code: number,
): Parameters<Context<IdempotencyEnv>['json']>[1] {
    return code as Parameters<Context<IdempotencyEnv>['json']>[1];
}

/**
 * 2xx → the mutation succeeded, cache it.
 * 409 → the mutation was a no-op replay of an already-applied state
 *       (design §E2). Caching it means every subsequent retry sees the
 *       same 409 body, which is what the mobile drain loop expects.
 */
function isCacheableStatus(status: number): boolean {
    return (status >= 200 && status < 300) || status === 409;
}

/**
 * Read the downstream response body as a JSON object. Returns `null`
 * and logs at warn level when the body is missing, not JSON, or not a
 * plain object — those responses are not cache-safe because the DB
 * helper requires `body: Record<string, unknown>`.
 *
 * We clone the response before consuming it so the original stream
 * reaches the client untouched.
 */
async function readJsonBody(
    c: Context<IdempotencyEnv>,
    logger: IdempotencyLogger,
): Promise<Record<string, unknown> | null> {
    const res = c.res;
    const contentType = res.headers.get('content-type');
    if (contentType === null || !contentType.toLowerCase().includes('application/json')) {
        logger.warn('response is not JSON; skipping idempotency store', {
            contentType,
            status: res.status,
        });
        return null;
    }

    let parsed: unknown;
    try {
        parsed = await res.clone().json();
    } catch (err) {
        logger.warn('response body not valid JSON; skipping idempotency store', {
            status: res.status,
            error: errorToDetail(err),
        });
        return null;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        logger.warn('response body not a plain object; skipping idempotency store', {
            status: res.status,
        });
        return null;
    }

    return parsed as Record<string, unknown>;
}

/**
 * Shrink an unknown thrown value into something safe to serialise into
 * logs. Keeps the `name` and `message` of `Error` instances and coerces
 * anything else to its `String()` representation.
 */
function errorToDetail(err: unknown): { name?: string; message: string } {
    if (err instanceof Error) {
        return { name: err.name, message: err.message };
    }
    return { message: String(err) };
}
