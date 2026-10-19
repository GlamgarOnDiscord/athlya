/**
 * Idempotency-key store.
 *
 * The API gateway's idempotency middleware (task 4.2) uses two entry
 * points on this module:
 *
 *   1. {@link lookup} — check whether an `Idempotency-Key` header was
 *      already processed for this user and, if so, return the stored
 *      response so the server replays it without re-executing the
 *      mutation. Requirement 20.1.
 *
 *   2. {@link store} — persist the freshly computed response for
 *      exactly 24 hours (default) so subsequent replays hit the cache.
 *      Requirement 20.2.
 *
 * Concurrency model
 * -----------------
 * Two clients can race on the miss path — both read `null` from
 * {@link lookup}, both execute the mutation, both then call
 * {@link store}. The `INSERT … ON CONFLICT (key, user_id) DO NOTHING`
 * clause guarantees *first-write-wins*: whoever commits first installs
 * the response, the loser silently gives up. The API gateway therefore
 * always observes a single canonical response after the race resolves,
 * even though the mutation body may have been executed twice — which is
 * why the mutation itself must be independently idempotent (unique
 * constraint on `reservations(class_id, user_id)` etc.). The design
 * document E2 (§Error Cases) calls this out.
 *
 * Expiry is enforced in SQL (`WHERE expires_at > now()`) rather than in
 * the caller so clock skew between the middleware host and the DB
 * cannot serve stale entries. The scheduled maintenance tick deletes
 * expired rows through `idempotency_purge_expired` (migration 0047,
 * issue #689); the index `idempotency_keys_expires_at_idx` makes that
 * sweep cheap.
 *
 * Related requirements: 20.1, 20.2.
 */

import { sql } from 'drizzle-orm';

import { DbError } from './errors.js';

import type { AthlyaDb, AthlyaDbHttp, AthlyaTx } from './client.js';

/** Union of every Drizzle handle that supports `.execute(sql\`...\`)`. */
export type IdempotencyDb = AthlyaDb | AthlyaDbHttp | AthlyaTx;

/** RFC 4122 UUID v1–8 with variant bits. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Upper bound on the `Idempotency-Key` header length. The SQL column is
 * `text` and therefore unbounded, but a sensible ceiling at the helper
 * layer protects the key index from accidental blow-up via a malformed
 * header, and keeps error messages actionable.
 */
const KEY_MAX_LENGTH = 255;

/** One day, in seconds — the minimum retention window mandated by Req 20.2. */
export const DEFAULT_IDEMPOTENCY_TTL_SEC = 24 * 60 * 60;

/**
 * Thrown when one of the helper's inputs fails basic shape validation.
 * Surfaces as {@link DbError} at the API boundary (never a 4xx) because
 * a malformed key on this path indicates a bug in the middleware, not a
 * client error — the middleware validates the raw header before calling
 * into this module.
 */
export class InvalidIdempotencyInputError extends DbError {
  public constructor(field: 'key' | 'userId' | 'response' | 'ttlSec', reason: string) {
    super('invalid_idempotency_input', `invalid idempotency input "${field}": ${reason}`);
    this.name = 'InvalidIdempotencyInputError';
  }
}

/**
 * Domain shape returned by {@link lookup}. `response` is the full body
 * the gateway originally emitted — headers worth replaying (e.g.
 * `Location`) can live inside it under a reserved key. Callers stamp
 * the HTTP status from {@link statusCode}.
 */
export interface IdempotencyEntry {
  readonly response: Record<string, unknown>;
  readonly statusCode: number;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/**
 * Wire shape returned by postgres-js for our idempotency SELECT. We
 * alias the snake_case columns explicitly rather than reusing the
 * drizzle `$inferSelect` type because the raw SQL path does not go
 * through drizzle's column mapper, so the returned object uses the
 * server's column names verbatim.
 *
 * This is declared as an `interface` with an explicit `[key: string]:
 * unknown` index signature rather than as an intersection with
 * `Record<string, unknown>`. Drizzle's `tx.execute<T>()` constrains
 * `T extends Record<string, unknown>`, and that constraint is only
 * satisfied when every concrete field's type is assignable to
 * `unknown` AND the object carries an index signature. The interface
 * form makes both requirements visible at the declaration site and
 * compiles cleanly under strict mode, whereas the intersection form
 * relies on a structural-assignability accident that TypeScript
 * tightened up between releases.
 */
interface IdempotencyRowRaw {
  response: Record<string, unknown>;
  status_code: number;
  created_at: Date;
  expires_at: Date;
  [key: string]: unknown;
}

/**
 * Look up the stored response for `(key, userId)`.
 *
 * Returns `null` in two cases:
 *   - no matching row exists (first call with this key), or
 *   - a row exists but `expires_at <= now()` (stale).
 *
 * The expiry check is inlined in the `WHERE` clause so a concurrent
 * sweeper never observes the stale row either — the DB's monotonic
 * clock is the single source of truth.
 */
export async function lookup(
  tx: IdempotencyDb,
  key: string,
  userId: string,
): Promise<IdempotencyEntry | null> {
  validateKey(key);
  validateUserId(userId);

  const result = await tx.execute<IdempotencyRowRaw>(sql`
        SELECT response, status_code, created_at, expires_at
          FROM idempotency_keys
         WHERE key = ${key}
           AND user_id = ${userId}
           AND expires_at > now()
         LIMIT 1
    `);

  // drizzle-orm/postgres-js returns a `RowList` that extends the row
  // array with driver metadata; we only care about indexed access.
  const rows = result as unknown as readonly IdempotencyRowRaw[];
  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    response: row.response,
    statusCode: row.status_code,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Persist a mutation response for future replays.
 *
 * `ttlSec` defaults to 24 hours (Req 20.2). The `ON CONFLICT … DO NOTHING`
 * clause makes the operation race-safe: if a concurrent writer has
 * already committed a row for the same `(key, user_id)`, our insert
 * silently no-ops — first-write-wins. See the module header for why
 * that is the correct semantics.
 *
 * The response body is stringified explicitly and cast to `jsonb` with
 * `::jsonb` to avoid relying on the driver's implicit object-to-jsonb
 * conversion, which depends on column metadata we do not exchange with
 * raw SQL. `make_interval(secs => :ttlSec)` keeps the TTL expression
 * parameterised and side-steps string concatenation into the SQL text.
 */
export async function store(
  tx: IdempotencyDb,
  key: string,
  userId: string,
  response: { readonly body: Record<string, unknown>; readonly statusCode: number },
  ttlSec: number = DEFAULT_IDEMPOTENCY_TTL_SEC,
): Promise<void> {
  validateKey(key);
  validateUserId(userId);
  validateResponse(response);
  validateTtl(ttlSec);

  const serialisedBody = JSON.stringify(response.body);

  await tx.execute(sql`
        INSERT INTO idempotency_keys (key, user_id, response, status_code, expires_at)
        VALUES (
            ${key},
            ${userId},
            ${serialisedBody}::jsonb,
            ${response.statusCode},
            now() + make_interval(secs => ${ttlSec})
        )
        ON CONFLICT (key, user_id) DO NOTHING
    `);
}

function validateKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new InvalidIdempotencyInputError('key', 'must be a non-empty string');
  }
  if (key.length > KEY_MAX_LENGTH) {
    throw new InvalidIdempotencyInputError('key', `must be ≤ ${String(KEY_MAX_LENGTH)} characters`);
  }
}

function validateUserId(userId: string): void {
  if (typeof userId !== 'string' || !UUID_REGEX.test(userId)) {
    throw new InvalidIdempotencyInputError('userId', 'must be a UUID');
  }
}

function validateResponse(response: {
  readonly body: Record<string, unknown>;
  readonly statusCode: number;
}): void {
  if (response === null || typeof response !== 'object') {
    throw new InvalidIdempotencyInputError('response', 'must be an object');
  }
  if (
    typeof response.statusCode !== 'number' ||
    !Number.isInteger(response.statusCode) ||
    response.statusCode < 100 ||
    response.statusCode > 599
  ) {
    throw new InvalidIdempotencyInputError(
      'response',
      `statusCode must be an integer in [100, 599], got ${String(response.statusCode)}`,
    );
  }
  if (response.body === null || typeof response.body !== 'object') {
    throw new InvalidIdempotencyInputError('response', 'body must be a plain object');
  }
}

function validateTtl(ttlSec: number): void {
  if (
    typeof ttlSec !== 'number' ||
    !Number.isFinite(ttlSec) ||
    !Number.isInteger(ttlSec) ||
    ttlSec <= 0
  ) {
    throw new InvalidIdempotencyInputError(
      'ttlSec',
      `must be a positive integer, got ${String(ttlSec)}`,
    );
  }
}
