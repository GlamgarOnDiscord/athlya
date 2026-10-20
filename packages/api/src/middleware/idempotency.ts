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
 * Strict mode (opt-in, used by the reservation routes)
 * ----------------------------------------------------
 * Three options harden a route whose duplicate would cost a seat:
 *
 *   • `inFlight`: an atomic in-flight marker (`SET NX` with a short
 *     TTL) taken after a cache miss. A concurrent duplicate that finds
 *     it held is answered `409 idempotency_in_progress` with
 *     `Retry-After`, instead of running the mutation a second time
 *     before the first one stored its response. The lookup is repeated
 *     once the marker is held, so a request that finished in between
 *     is replayed, not re-run.
 *   • `bindRequest`: the stored entry carries a SHA-256 of method,
 *     path, user and body (under a reserved key stripped on replay).
 *     A key reused for a different request is refused with
 *     `422 idempotency_key_reused`. Entries stored before the hash
 *     existed replay as before.
 *   • `failClosed`: a lookup or in-flight store that cannot be reached
 *     answers `503 idempotency_unavailable` (retryable) instead of
 *     running the mutation unprotected. A store write that fails AFTER
 *     the mutation committed still returns the real response: the
 *     mutation cannot be undone, and the domain guards (partial unique
 *     index, `already_cancelled`) keep a later retry harmless.
 *
 * Routes that set none of the three keep the original behaviour below.
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

import type { IdempotencyDb, IdempotencyEntry } from '@athlya/db/idempotency';
import type { Context, MiddlewareHandler } from 'hono';

/** Default retention — exactly 24 h, the minimum mandated by Req 20.2. */
export const DEFAULT_IDEMPOTENCY_TTL_SEC = 24 * 60 * 60;

/** HTTP methods the middleware inspects. Read-only verbs pass through. */
const DEFAULT_MUTATION_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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
   * Drizzle handle — postgres-js, Neon HTTP, or a transaction.
   * All three support `.execute(sql\`...\`)` which is the only operation
   * the idempotency store uses.
   */
  readonly db: IdempotencyDb;
  /** Retention in seconds. Defaults to {@link DEFAULT_IDEMPOTENCY_TTL_SEC}. */
  readonly ttlSec?: number;
  /** HTTP methods considered mutations. Defaults to POST/PUT/PATCH/DELETE. */
  readonly mutationMethods?: ReadonlySet<string>;
  /** Swappable logger for warn/error paths. Defaults to `console`. */
  readonly logger?: IdempotencyLogger;
  /** Atomic in-flight marker. Unset: concurrent duplicates are not detected. */
  readonly inFlight?: IdempotencyInFlightLock;
  /** In-flight marker TTL. Defaults to {@link DEFAULT_IN_FLIGHT_TTL_SEC}. */
  readonly inFlightTtlSec?: number;
  /** Bind each key to a hash of method, path, user and body. */
  readonly bindRequest?: boolean;
  /** Refuse with 503 instead of running unprotected when the stores are down. */
  readonly failClosed?: boolean;
}

/**
 * Atomic in-flight marker, keyed per `(user, Idempotency-Key)`. The
 * production adapter is a Redis `SET NX EX` plus a token-checked
 * delete, so a marker that expired and was re-taken by another request
 * is never released by the first one.
 */
export interface IdempotencyInFlightLock {
  /** Take the marker; `false` when another request already holds it. */
  acquire(key: string, token: string, ttlSec: number): Promise<boolean>;
  /** Drop the marker if `token` still owns it. */
  release(key: string, token: string): Promise<void>;
}

/**
 * In-flight marker lifetime. Long enough to cover a booking (two
 * transactions and a Redis round trip), short enough that a crashed
 * isolate does not block the key for long.
 */
export const DEFAULT_IN_FLIGHT_TTL_SEC = 30;

/** Seconds a client is told to wait before retrying a 409 in progress or a 503. */
const RETRY_AFTER_SEC = '1';

/** Reserved field carrying the request hash inside the stored response body. */
export const IDEMPOTENCY_REQUEST_HASH_FIELD = '__idempotencyRequestHash';

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
 *   4. `userId` is read from `c.get('userId')`. Without an
 *      authenticated user (public routes such as `/v1/auth/login` and
 *      `/v1/auth/register`) there is no cache scope, so the request
 *      passes through unchanged: no lookup, no store.
 *   5. On a fresh, non-expired cache hit, the stored body and status are
 *      replayed via `c.json()`. The downstream handler is NOT invoked,
 *      satisfying Req 20.1.
 *   6. On a miss, `next()` runs; if the response status is 2xx or 409
 *      and the body is JSON, we store `{ body, statusCode }` with the
 *      configured TTL so the next retry replays verbatim.
 *   7. Storage failures are caught and logged — they never mask the
 *      user-visible response.
 *   8. Strict mode (`inFlight`, `bindRequest`, `failClosed`) adds the
 *      in-flight marker, the request hash and the 503 fail-closed
 *      answers described in the module header.
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
      // Cache entries are scoped per user; an anonymous request has no
      // scope to replay from, so it runs without idempotency caching
      // instead of failing a public route that sent the header.
      await next();
      return;
    }

    const failClosed = deps.failClosed === true;
    const fingerprint =
      deps.bindRequest === true ? await requestFingerprint(c, method, userId) : undefined;

    // --- Lookup path (Req 20.1) -------------------------------------
    const first = await safeLookup(deps, key, userId, logger);
    if (first === 'error' && failClosed) {
      return unavailable(c);
    }
    if (first !== 'error' && first !== null) {
      return replay(c, first, fingerprint);
    }

    // --- In-flight marker (strict mode) -----------------------------
    let lockToken: string | undefined;
    const lockKey = `idem:inflight:${userId}:${key}`;
    if (deps.inFlight !== undefined) {
      const token = crypto.randomUUID();
      let acquired: boolean | 'error';
      try {
        acquired = await deps.inFlight.acquire(
          lockKey,
          token,
          deps.inFlightTtlSec ?? DEFAULT_IN_FLIGHT_TTL_SEC,
        );
      } catch (err) {
        logger.error('in-flight acquire failed', { key, userId, error: errorToDetail(err) });
        acquired = 'error';
      }
      if (acquired === 'error' && failClosed) {
        return unavailable(c);
      }
      if (acquired === false) {
        return c.json(
          {
            type: 'about:blank',
            title: 'idempotency_in_progress',
            status: 409,
            code: 'idempotency_in_progress',
            detail: 'A request with this Idempotency-Key is still being processed',
          },
          409,
          { 'retry-after': RETRY_AFTER_SEC },
        );
      }
      if (acquired === true) {
        lockToken = token;
        // A duplicate that finished between our first lookup and the
        // marker stored its response: replay it rather than re-run.
        const second = await safeLookup(deps, key, userId, logger);
        if (second === 'error' && failClosed) {
          await safeRelease(deps.inFlight, lockKey, token, logger);
          return unavailable(c);
        }
        if (second !== 'error' && second !== null) {
          await safeRelease(deps.inFlight, lockKey, token, logger);
          return replay(c, second, fingerprint);
        }
      }
    }

    // --- Execute path ------------------------------------------------
    try {
      await next();

      const status = c.res.status;
      if (!isCacheableStatus(status)) {
        return;
      }

      const body = await readJsonBody(c, logger);
      if (body === null) {
        return;
      }

      const stored =
        fingerprint === undefined
          ? body
          : { ...body, [IDEMPOTENCY_REQUEST_HASH_FIELD]: fingerprint };
      try {
        await store(deps.db, key, userId, { body: stored, statusCode: status }, ttlSec);
      } catch (err) {
        const detail = { key, userId, status, error: errorToDetail(err) };
        if (failClosed) {
          logger.error('store failed after the mutation; continuing without cache', detail);
        } else {
          logger.warn('store failed; continuing without cache', detail);
        }
      }
      return;
    } finally {
      if (lockToken !== undefined && deps.inFlight !== undefined) {
        await safeRelease(deps.inFlight, lockKey, lockToken, logger);
      }
    }
  };
}

/** Lookup that reports a store failure as `'error'` instead of throwing. */
async function safeLookup(
  deps: IdempotencyMiddlewareDeps,
  key: string,
  userId: string,
  logger: IdempotencyLogger,
): Promise<IdempotencyEntry | null | 'error'> {
  try {
    return await lookup(deps.db, key, userId);
  } catch (err) {
    // Degrades to "miss" unless the route fails closed. Repeated
    // entries should trigger an Axiom alert.
    logger.error('lookup failed', { key, userId, error: errorToDetail(err) });
    return 'error';
  }
}

async function safeRelease(
  lock: IdempotencyInFlightLock,
  lockKey: string,
  token: string,
  logger: IdempotencyLogger,
): Promise<void> {
  try {
    await lock.release(lockKey, token);
  } catch (err) {
    // The TTL frees the marker anyway; a failed release only delays
    // the next duplicate by at most that long.
    logger.warn('in-flight release failed', { lockKey, error: errorToDetail(err) });
  }
}

/**
 * Replay a stored response with its original status. A request hash
 * that does not match the stored one means the key was reused for a
 * different request: refuse instead of answering with someone else's
 * result.
 */
function replay(
  c: Context<IdempotencyEnv>,
  hit: IdempotencyEntry,
  fingerprint: string | undefined,
): Response {
  const { [IDEMPOTENCY_REQUEST_HASH_FIELD]: storedHash, ...body } = hit.response;
  if (fingerprint !== undefined && typeof storedHash === 'string' && storedHash !== fingerprint) {
    return c.json(
      {
        type: 'about:blank',
        title: 'idempotency_key_reused',
        status: 422,
        code: 'idempotency_key_reused',
        detail: 'This Idempotency-Key was already used for a different request',
      },
      422,
    );
  }
  c.header('idempotent-replayed', 'true');
  return c.json(body, statusCodeOf(hit.statusCode));
}

function unavailable(c: Context<IdempotencyEnv>): Response {
  return c.json(
    {
      type: 'about:blank',
      title: 'idempotency_unavailable',
      status: 503,
      code: 'idempotency_unavailable',
      detail: 'Duplicate protection is temporarily unavailable; retry in a moment',
    },
    503,
    { 'retry-after': RETRY_AFTER_SEC },
  );
}

/**
 * SHA-256 over method, path, user and raw body. Hono caches the body
 * text once a validator parsed it, so this reads the same bytes the
 * handler validated.
 */
async function requestFingerprint(
  c: Context<IdempotencyEnv>,
  method: string,
  userId: string,
): Promise<string> {
  let body = '';
  try {
    body = await c.req.text();
  } catch {
    body = '';
  }
  const data = new TextEncoder().encode([method, c.req.path, userId, body].join('\n'));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Narrow Hono's `StatusCode` slot to the numeric subtype it accepts at
 * runtime. The DB column is a `smallint` in `[100, 599]` (enforced by
 * `validateResponse` in the helper), so any surviving number is safe
 * for `c.json`.
 */
function statusCodeOf(code: number): Parameters<Context<IdempotencyEnv>['json']>[1] {
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
