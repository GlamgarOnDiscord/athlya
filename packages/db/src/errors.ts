/**
 * Typed error classes thrown by `@athlya/db` + Postgres SQLSTATE
 * predicates shared across every adapter that talks to the
 * database.
 *
 * Why custom classes instead of plain `Error`?
 *   The API gateway's error middleware (task 8.5) maps error *classes* —
 *   not string messages — to HTTP status codes and Problem Details
 *   envelopes. Using `instanceof` at the boundary keeps the mapping
 *   resilient to message edits and to localization.
 *
 * Why centralise the SQLSTATE predicates?
 *   Both `auth-user-repo-drizzle.ts` and `reservations-write-drizzle.ts`
 *   shipped their own copy of `isPostgresUniqueViolation` (Vague 13 +
 *   Vague 14 fix walking the `cause` chain). Slice B8.1 collapses the
 *   duplication so the cause-chain walk and the SQLSTATE constants
 *   live in exactly one place — every adapter that needs to detect
 *   a unique-violation, foreign-key-violation, check-violation,
 *   serialization-failure or deadlock-detected import these helpers
 *   instead of re-implementing the recursion + comparison.
 *
 * Related requirements:
 *   - 13.5: cross-tenant reads surface as `404 Not Found` so resource
 *     existence is never leaked. `NotFoundError` is the canonical carrier.
 *   - 14.6: every thrown error is rendered as an RFC 7807 Problem Details
 *     document upstream.
 */

/**
 * Root error for the database layer. Everything thrown by this package
 * extends `DbError` so upstream code can catch a single class when
 * distinguishing "our problem" from driver-level exceptions.
 */
export class DbError extends Error {
    /**
     * Short, stable identifier suitable for the Problem Details `type`
     * field and for observability tags. Kept separate from the human
     * message because the message may be localized or redacted.
     */
    public readonly code: string;

    public constructor(code: string, message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'DbError';
        this.code = code;
    }
}

/**
 * Signals that a query — after RLS filtering — returned no rows for a
 * resource the caller explicitly referenced. The API gateway translates
 * this to HTTP 404 regardless of whether the row truly does not exist or
 * whether it belongs to another tenant, so existence of cross-tenant
 * resources is not disclosed (Requirement 13.5).
 */
export class NotFoundError extends DbError {
    public constructor(detail = 'resource not found') {
        super('not_found', detail);
        this.name = 'NotFoundError';
    }
}

/**
 * Convenience helper used by repository functions: takes the result of a
 * `SELECT … LIMIT 1` (or any single-row lookup) and returns the row, or
 * throws {@link NotFoundError} if the array is empty.
 *
 * The helper is intentionally strict on arity — `rows.length > 1` is a
 * programmer bug (missed `LIMIT`, wrong filter) and should surface as a
 * `DbError` rather than silently dropping rows.
 */
export function notFoundIfEmpty<T>(rows: readonly T[], detail?: string): T {
    if (rows.length === 0) {
        throw new NotFoundError(detail);
    }
    if (rows.length > 1) {
        throw new DbError(
            'unexpected_multiple_rows',
            `expected at most one row, got ${String(rows.length)}`,
        );
    }
    // Safe: we just checked length === 1.
    return rows[0] as T;
}

/* ------------------------------------------------------------------ */
/*  Postgres SQLSTATE predicates                                       */
/* ------------------------------------------------------------------ */

/**
 * SQLSTATE codes we care about across the adapter layer.
 *
 * Reference: PostgreSQL 17 documentation, "Appendix A. PostgreSQL
 * Error Codes" — class 23 (Integrity Constraint Violation) and
 * class 40 (Transaction Rollback).
 */
const PG_SQLSTATE = {
    /** unique_violation — duplicate key value violates UNIQUE. */
    UNIQUE_VIOLATION: '23505',
    /** foreign_key_violation — INSERT/UPDATE breaks an FK. */
    FOREIGN_KEY_VIOLATION: '23503',
    /** check_violation — INSERT/UPDATE breaks a CHECK constraint. */
    CHECK_VIOLATION: '23514',
    /** serialization_failure — could not serialize access due to concurrent update. */
    SERIALIZATION_FAILURE: '40001',
    /** deadlock_detected — deadlock detected, transaction was rolled back. */
    DEADLOCK_DETECTED: '40P01',
} as const;

/**
 * Walk the `cause` chain on `err` and return `true` if any node
 * carries the given SQLSTATE on its `.code` property.
 *
 * Drizzle wraps the raw postgres-js error inside a `Failed query: …`
 * `Error` and stores the original error on `.cause`. The HTTP-driver
 * (`@neondatabase/serverless`) does the same. We therefore CANNOT
 * just look at `err.code` — we must descend through `.cause`.
 *
 * The walk is bounded by an explicit visited-set so a self-referential
 * cause chain (constructed by accident or by a buggy wrapper) cannot
 * cause infinite recursion.
 */
function hasPostgresCode(err: unknown, sqlstate: string): boolean {
    const seen = new Set<unknown>();
    let cursor: unknown = err;
    while (cursor !== undefined && cursor !== null) {
        if (typeof cursor !== 'object') return false;
        if (seen.has(cursor)) return false;
        seen.add(cursor);

        if ((cursor as { code?: unknown }).code === sqlstate) {
            return true;
        }
        cursor = (cursor as { cause?: unknown }).cause;
    }
    return false;
}

/**
 * Detect Postgres SQLSTATE 23505 (unique_violation).
 *
 * Walks the `.cause` chain so it works whether the caller is using the
 * postgres-js driver (raw error at the top level) or Drizzle (wraps in
 * `Failed query: …` with the raw error on `.cause`).
 *
 * Replaces the per-adapter copies that previously lived in
 * `auth-user-repo-drizzle.ts` and `reservations-write-drizzle.ts`.
 */
export function isPostgresUniqueViolation(err: unknown): boolean {
    return hasPostgresCode(err, PG_SQLSTATE.UNIQUE_VIOLATION);
}

/**
 * Detect Postgres SQLSTATE 23503 (foreign_key_violation). Useful at
 * write paths that touch FK-referenced tables (e.g. inserting a
 * reservation whose `class_id` no longer exists).
 */
export function isPostgresForeignKeyViolation(err: unknown): boolean {
    return hasPostgresCode(err, PG_SQLSTATE.FOREIGN_KEY_VIOLATION);
}

/**
 * Detect Postgres SQLSTATE 23514 (check_violation). Useful when a
 * domain invariant is enforced both in TS and via a CHECK constraint
 * — a 23514 surfaces as a "drift" between the two layers.
 */
export function isPostgresCheckViolation(err: unknown): boolean {
    return hasPostgresCode(err, PG_SQLSTATE.CHECK_VIOLATION);
}

/**
 * Detect Postgres SQLSTATE 40001 (serialization_failure). The booking
 * + cancel paths run with `SERIALIZABLE` isolation; a 40001 means the
 * transaction must be retried by the caller (the optimistic-retry
 * pattern shipped in `withConnectionRetry`).
 */
export function isPostgresSerializationFailure(err: unknown): boolean {
    return hasPostgresCode(err, PG_SQLSTATE.SERIALIZATION_FAILURE);
}

/**
 * Detect Postgres SQLSTATE 40P01 (deadlock_detected). Same retry
 * disposition as `isPostgresSerializationFailure`.
 */
export function isPostgresDeadlockDetected(err: unknown): boolean {
    return hasPostgresCode(err, PG_SQLSTATE.DEADLOCK_DETECTED);
}
