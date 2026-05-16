/**
 * Members service — RGPD deletion cascade consumer.
 *
 * Implements task 5.4 of the Athlya implementation plan. Two use
 * cases live in this module:
 *
 *   - {@link handleUserDeleted} — `auth.user.deleted` event consumer
 *     that cascade-deletes every row downstream of the soft-deleted
 *     user (`reservations`, `workout_sessions`, `push_tokens`),
 *     stamps the `users.deleted_at` tombstone, best-effort purges
 *     the R2 avatar binary, and schedules the 30-day audit-log
 *     anonymisation job (Requirements 5.2, 5.3).
 *   - {@link anonymizeAuditLog} — the delayed job itself, running
 *     against the `audit_log` table: `actor_id = NULL` and PII is
 *     stripped from the `metadata` JSON (Requirement 5.3). Exposed
 *     as a separate export so the scheduler can invoke it directly
 *     when the QStash 30-day timer fires.
 *
 * The cascade consumer is intentionally *not* transactional across
 * every delete — each repo call commits independently — because the
 * outer contract is "eventually, no row referencing this user
 * remains" (Requirement 5.4), and event-bus redelivery (Cloudflare
 * Queues, Requirement 16.5) is the durability mechanism. The
 * orchestration therefore only needs to guarantee two invariants:
 *
 *   1. Row-level deletions are retryable. Every repo method is
 *      expected to behave like `DELETE ... WHERE user_id = $1`, which
 *      is idempotent: re-running it after a partial failure matches
 *      fewer rows but does no harm.
 *   2. The 30-day anonymisation job is scheduled at most once on the
 *      happy path, and — critically — scheduling failures rethrow so
 *      the event bus redelivers the whole cascade (`scheduler.publish`
 *      is the only step we cannot afford to silently drop, because
 *      the legal retention window is tied to its completion).
 *
 * Avatar purge is best-effort: a failing R2 call is logged at `warn`
 * and the cascade proceeds. The rationale is that the user has
 * already been soft-deleted; leaving a stale binary in R2 for a few
 * hours is a far smaller compliance risk than refusing to delete the
 * SQL rows because the blob store is transiently unavailable.
 *
 * Framework-free by design: the module depends only on the six
 * pluggable ports declared below. Concrete implementations (Drizzle
 * repo wrapped under `withTenant`, R2 binding, QStash publisher) are
 * assembled by the API gateway and the worker Wrangler entry point.
 */

import type { Clock } from './export.js';
import type { AuthUserDeletedEvent } from '@athlya/shared/events';

// Re-export so callers of this module don't need a second import path
// to satisfy the {@link HandleUserDeletedDeps} / `clock` port. The
// `Clock` type is shared across the members package (identical shape
// in `./export.js`) to keep a single canonical definition.
export type { Clock };

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/**
 * Number of days to wait between the soft-delete `deleted_at`
 * tombstone and the audit-log anonymisation pass. Derived directly
 * from Requirement 5.3 ("30 days have elapsed since a user's
 * `deleted_at` timestamp"). Exported as a named constant so the
 * tests assert the exact delay stamped into the scheduler, and so
 * the operations team can audit the value at a glance.
 */
export const ANONYMIZATION_DELAY_DAYS = 30;

/** Same constant expressed in milliseconds for arithmetic convenience. */
export const ANONYMIZATION_DELAY_MS =
    ANONYMIZATION_DELAY_DAYS * 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/*  Ports                                                              */
/* ------------------------------------------------------------------ */

/**
 * Persistence port for the RGPD deletion cascade. Each method is a
 * self-contained `DELETE ... WHERE user_id = $1` (or the audit
 * anonymisation equivalent) wrapped under
 * `withTenant(claims, fn)` by the production implementation so RLS
 * (Requirement 13) is applied.
 *
 * Every deletion method returns the number of rows actually removed
 * so the caller can log / emit metrics; the count is best-effort and
 * MUST NOT drive correctness decisions (see the retry posture
 * discussed in the module docblock).
 *
 * `markUserDeleted` soft-deletes the users row itself. The Auth
 * service already stamps `deleted_at` when it emits the
 * `auth.user.deleted` event (Requirement 5.1), so in practice this
 * call is a no-op the first time through; we still invoke it so a
 * replayed event on a corrupted users row will heal the tombstone.
 *
 * `anonymizeAuditRows` is the only method that touches `audit_log`.
 * Its implementation is expected to be idempotent — a second call
 * with the same `userId` finds zero remaining rows carrying
 * `actor_id = userId` and returns 0. Tests in this package exercise
 * the caller's contract (the function simply forwards to the repo
 * and returns its count); repo-level idempotency is covered by the
 * pgTAP suite under `packages/db`.
 */
export interface DeletionRepo {
    /** Hard-delete every `reservations` row owned by `userId`. */
    deleteReservationsForUser(userId: string): Promise<number>;
    /** Hard-delete every `workout_sessions` row owned by `userId`. */
    deleteWorkoutSessionsForUser(userId: string): Promise<number>;
    /** Hard-delete every `push_tokens` row owned by `userId`. */
    deletePushTokensForUser(userId: string): Promise<number>;
    /** Soft-delete the users row: `deleted_at = deletedAt`. Idempotent. */
    markUserDeleted(userId: string, deletedAt: Date): Promise<void>;
    /**
     * Set `actor_id = NULL` on every `audit_log` row whose
     * `actor_id = userId`, stripping PII from `metadata` in the same
     * statement. Returns the count of rows actually anonymised.
     */
    anonymizeAuditRows(userId: string): Promise<number>;
}

/**
 * Minimal Cloudflare R2 port for avatar purge. The production
 * implementation deletes under the `avatars/{userId}` prefix; the
 * test doubles record the call. Kept as a standalone port (rather
 * than a method on {@link DeletionRepo}) because R2 is a different
 * Cloudflare binding than Neon and because a transient R2 failure
 * must NOT abort the SQL cascade.
 */
export interface AvatarStore {
    /**
     * Delete the avatar binary for `userId` from R2. Implementations
     * SHOULD treat "object does not exist" as success (idempotent
     * best-effort delete).
     */
    deleteAvatar(userId: string): Promise<void>;
}

/**
 * Scheduler port for the delayed anonymisation job. The production
 * implementation publishes to Upstash QStash with a delay computed
 * from `dueAt - now`; the test double records the call. The
 * contract is that `dueAt` is an absolute wall-clock time — the
 * scheduler takes care of converting it into whatever relative
 * delay QStash wants.
 *
 * A scheduling failure on this port is fatal: the 30-day legal
 * retention clock is tied to this job landing in QStash. The
 * consumer therefore rethrows any failure so the event bus redrives
 * the whole cascade (dedup on `event.id` is handled one layer up
 * by the consumer dispatcher).
 */
export interface Scheduler {
    /**
     * Enqueue an anonymisation job for `userId` to run at `dueAt`.
     * Idempotency is the scheduler's responsibility — publishers
     * may retry after a transient failure without creating a
     * duplicate job.
     */
    scheduleAnonymization(userId: string, dueAt: Date): Promise<void>;
}

/** Abstract clock so tests can freeze `now()`. Re-exported from
 * `./export.js` to keep a single canonical definition across the
 * members package — see the module preamble above. */

/**
 * Logger port. Only `warn` and `error` are required; the cascade
 * never logs at info level. Shape matches the logger used by the
 * other members use cases so a single concrete implementation can
 * be shared across the package.
 */
export interface Logger {
    warn(msg: string, extra?: Record<string, unknown>): void;
    error(msg: string, extra?: Record<string, unknown>): void;
}

/* ------------------------------------------------------------------ */
/*  Deps / results                                                     */
/* ------------------------------------------------------------------ */

/** Dependencies injected into {@link handleUserDeleted}. */
export interface HandleUserDeletedDeps {
    repo: DeletionRepo;
    avatars: AvatarStore;
    scheduler: Scheduler;
    clock: Clock;
    logger?: Logger;
}

/** Dependencies injected into {@link anonymizeAuditLog}. */
export interface AnonymizeAuditLogDeps {
    repo: Pick<DeletionRepo, 'anonymizeAuditRows'>;
    logger?: Logger;
}

/**
 * Per-table row counts produced by the cascade. `auditAnonymized` is
 * stamped at 0 in the cascade result because the actual audit
 * anonymisation runs 30 days later — the field is kept on the shape
 * so the result type is uniform with {@link AnonymizeAuditLogResult}
 * and so downstream observability pipelines can aggregate both
 * phases through a single schema.
 */
export interface CascadeCounts {
    reservations: number;
    sessions: number;
    pushTokens: number;
    auditAnonymized: number;
}

/**
 * Discriminated result returned by {@link handleUserDeleted}. Only
 * the happy path is modelled — unexpected failures rethrow so the
 * event bus redrives (the consumer dedups on `event.id` one layer
 * up). `scheduledAnonymizationAt` is the ISO string of the wall-clock
 * instant the QStash job is targeting so the caller can log / assert
 * it deterministically.
 */
export type HandleUserDeletedResult = {
    readonly kind: 'ok';
    readonly counts: CascadeCounts;
    readonly scheduledAnonymizationAt: string;
};

/** Discriminated result returned by {@link anonymizeAuditLog}. */
export type AnonymizeAuditLogResult = {
    readonly kind: 'ok';
    readonly userId: string;
    readonly anonymizedRows: number;
};

/* ------------------------------------------------------------------ */
/*  handleUserDeleted                                                  */
/* ------------------------------------------------------------------ */

/**
 * Consume a single `auth.user.deleted` event.
 *
 * The cascade runs in a fixed order chosen so that any partial
 * failure leaves the system in a state that is safe to re-enter
 * (the event bus will redeliver):
 *
 *   1. `deleteReservationsForUser` — removes FK-joined reservations
 *      first so subsequent reads of the users row never expose an
 *      orphan booking list.
 *   2. `deleteWorkoutSessionsForUser` — personal training history.
 *   3. `deletePushTokensForUser` — device tokens; dropping these
 *      before the soft-delete tombstone prevents the notifications
 *      consumer from pushing to a deleted user if it races us.
 *   4. `markUserDeleted` — soft-delete the users row itself
 *      (idempotent; the Auth service already stamped `deleted_at`
 *      when it published this event).
 *   5. `avatars.deleteAvatar` — best-effort R2 purge. A failure here
 *      is logged at `warn` but does NOT abort the cascade — the
 *      SQL-side compliance invariant is already satisfied and R2
 *      cleanup can be re-attempted out-of-band.
 *   6. `scheduler.scheduleAnonymization` — must succeed. A failure
 *      here rethrows so the whole cascade is redelivered by the
 *      event bus; losing this step would miss the 30-day legal
 *      retention deadline.
 *
 * Requirements: 5.2, 5.3, 5.4.
 */
export async function handleUserDeleted(
    event: AuthUserDeletedEvent,
    deps: HandleUserDeletedDeps,
): Promise<HandleUserDeletedResult> {
    const userId = event.payload.userId;

    // Step 1–3: cascade FK-joined rows. Order matters (see docblock).
    const reservations = await deps.repo.deleteReservationsForUser(userId);
    const sessions = await deps.repo.deleteWorkoutSessionsForUser(userId);
    const pushTokens = await deps.repo.deletePushTokensForUser(userId);

    // Step 4: stamp the tombstone on the users row. Idempotent; the
    // Auth service normally set this already when emitting the event.
    const now = new Date(deps.clock.now());
    await deps.repo.markUserDeleted(userId, now);

    // Step 5: best-effort R2 avatar purge. Transient blob-store
    // failures must NOT block the SQL-side cascade completing —
    // rerunning the cascade is cheap, but losing the SQL deletions
    // because R2 hiccuped would leave the user in a half-deleted
    // state for the next redelivery window.
    try {
        await deps.avatars.deleteAvatar(userId);
    } catch (err) {
        deps.logger?.warn('cascade: avatar purge failed; continuing', {
            userId,
            eventId: event.id,
            error:
                err instanceof Error
                    ? { name: err.name, message: err.message }
                    : String(err),
        });
    }

    // Step 6: schedule the 30-day anonymisation job. Failures rethrow.
    const dueAt = new Date(now.getTime() + ANONYMIZATION_DELAY_MS);
    await deps.scheduler.scheduleAnonymization(userId, dueAt);

    return {
        kind: 'ok',
        counts: {
            reservations,
            sessions,
            pushTokens,
            // The audit anonymisation runs 30 days from now; at
            // cascade time no rows have been touched yet, so the
            // field is stamped at 0. The eventual
            // {@link AnonymizeAuditLogResult.anonymizedRows} is the
            // count that matters for compliance reporting.
            auditAnonymized: 0,
        },
        scheduledAnonymizationAt: dueAt.toISOString(),
    };
}

/* ------------------------------------------------------------------ */
/*  anonymizeAuditLog                                                  */
/* ------------------------------------------------------------------ */

/**
 * Run the 30-day audit-log anonymisation pass for `userId`.
 *
 * Delegates entirely to {@link DeletionRepo.anonymizeAuditRows},
 * which is expected to issue a single SQL statement equivalent to:
 *
 * ```sql
 * UPDATE audit_log
 *    SET actor_id = NULL,
 *        metadata = metadata - ARRAY['email', 'displayName', 'ip', 'userAgent']
 *  WHERE actor_id = $1;
 * ```
 *
 * Calling this function twice for the same `userId` is safe: the
 * second invocation matches zero rows and returns 0 without
 * side-effects. Tests exercise the function's wrapper contract
 * (single repo call, count forwarded unchanged); the SQL-level
 * idempotency guarantee is covered by pgTAP.
 *
 * Requirement: 5.3.
 */
export async function anonymizeAuditLog(
    userId: string,
    deps: AnonymizeAuditLogDeps,
): Promise<AnonymizeAuditLogResult> {
    const anonymizedRows = await deps.repo.anonymizeAuditRows(userId);
    return {
        kind: 'ok',
        userId,
        anonymizedRows,
    };
}
