/**
 * RGPD purge / anonymisation jobs — Sprint 2 Slices 2.2 + 2.3
 * (Vague 30, audit findings S5-004 + S5-005 + S5-006).
 *
 * Three pure functions plus their typed dependency contract. Every
 * job is idempotent, batch-bounded, and returns a count for ops
 * dashboards. The functions are framework-free: `worker.ts` will
 * call them from a `scheduled()` cron handler in a later commit
 * (out of Sprint-2 scope — that work needs the
 * `CRON_DB_URL` binding + `athlya_cron` Postgres role provisioning,
 * tracked as S5-003 separately).
 *
 * Findings resolved
 * -----------------
 *   • S5-004 [HIGH][PROD-RISK] — soft-deleted users persist
 *     indefinitely. {@link anonymizeExpiredUsers} replaces PII on
 *     rows where `deleted_at < now() - 30d` (in-place anonymisation
 *     rather than hard delete — keeps FKs from `reservations`,
 *     `workout_sessions`, `audit_log` valid for forensic /
 *     historical aggregates).
 *
 *   • S5-005 [HIGH][PROD-RISK] partial — `outbox` rows persist
 *     indefinitely after publication. {@link purgeExpiredOutbox}
 *     deletes rows where `published_at < now() - 7d`. The schema
 *     change (drop `email` from `auth.user.registered` payload) is
 *     applied separately in `packages/shared/src/events.ts` for
 *     forward-going events; this purge handles the existing tail.
 *
 *   • S5-006 [HIGH][PROD-RISK] — `export_jobs` rows accumulate.
 *     {@link purgeExpiredExportJobs} deletes terminal rows
 *     (`completed`, `failed`) requested more than 90 days ago.
 *
 * Why not Drizzle directly?
 * -------------------------
 * The functions accept a minimal `SqlExecutor` contract (just
 * `execute(query, params) → rowCount`) so they can be unit-tested
 * without spinning up a Postgres instance. The production wiring
 * (in a follow-up `worker.ts` cron handler) will adapt
 * `AthlyaDb.execute()` to this contract in three lines.
 *
 * @see docs/security/audit-S5-rgpd.md S5-004, S5-005, S5-006
 * @see packages/db/migrations/0003_audit_anonymization.sql (parallel
 *      function `anonymize_user_audit` for the audit_log surface,
 *      S5-003 tracked separately)
 */

/* ------------------------------------------------------------------ */
/*  Contract                                                           */
/* ------------------------------------------------------------------ */

/**
 * Minimal SQL executor surface. Implementations: a Drizzle
 * `db.execute(sql)` adaptor in production, an in-memory recorder
 * in tests.
 *
 * The `params` array is passed positionally — the SQL strings below
 * use `$1`, `$2`, `$3` placeholders to stay driver-agnostic.
 *
 * Returns the number of rows affected. Implementations that cannot
 * surface a row count (e.g. some pooler configurations) MAY return
 * `0` and rely on a follow-up COUNT — but the production driver
 * (`postgres-js` and `neon-http`) always exposes the count.
 */
export interface SqlExecutor {
  execute(query: string, params: readonly unknown[]): Promise<number>;
}

/**
 * Optional clock injection for deterministic testing. Defaults to
 * `Date.now()`.
 */
export interface PurgeClock {
  now(): Date;
}

const realClock: PurgeClock = { now: () => new Date() };

/* ------------------------------------------------------------------ */
/*  Common params                                                      */
/* ------------------------------------------------------------------ */

/** Default anonymisation window for soft-deleted users. */
export const DEFAULT_USER_ANONYMIZE_AFTER_DAYS = 30;

/** Default retention window for published outbox rows. */
export const DEFAULT_OUTBOX_RETENTION_DAYS = 7;

/** Default retention window for terminal export_jobs rows. */
export const DEFAULT_EXPORT_JOBS_RETENTION_DAYS = 90;

/**
 * Hard cap on how many rows a single batch may affect. Prevents a
 * job firing once-a-week on a large backlog from hot-blocking the
 * primary for minutes; the cron will simply re-fire on the next
 * tick until the backlog is drained.
 *
 * Issue #323 — 100 rows/tick keeps single-batch Neon transactions
 * well under the 30s CPU budget even during mass-churn events.
 */
export const DEFAULT_BATCH_LIMIT = 100;

/* ------------------------------------------------------------------ */
/*  S5-004 — anonymise expired soft-deleted users                      */
/* ------------------------------------------------------------------ */

/**
 * Result envelope for {@link anonymizeExpiredUsers}.
 *
 * `anonymizedCount` is the number of `users` rows that were just
 * stripped of PII this invocation. A returning value of 0 is the
 * steady-state for a healthy system (no users have crossed the
 * 30-day grace window since the last cron tick).
 */
export interface AnonymizeUsersResult {
  readonly anonymizedCount: number;
  /** True when the batch was full — indicates a backlog requiring more ticks. */
  readonly hasMore: boolean;
}

/**
 * Strip PII from `users` rows whose `deleted_at` is older than the
 * configured window. The row itself is kept so that historical FKs
 * (`reservations.user_id`, `workout_sessions.user_id`,
 * `audit_log.actor_id`) keep referencing a valid id — the spec
 * requires "right to be forgotten" but also "audit log immutability"
 * (Req 22.2), so in-place anonymisation is the only reconciliation.
 *
 * Anonymisation in-place:
 *   - `email` → `NULL` (the column is nullable since
 *               `0041_users_email_nullable.sql`, issue #628; readers
 *               treat a NULL email as an erased account)
 *   - `display_name` → `'[deleted]'` (sentinel surfaced in any
 *                                     historical export — the user is
 *                                     visibly anonymised)
 *   - `avatar_url` → `NULL`
 *   - `consents` → `'{}'::jsonb` (resets to empty document — keeps
 *                                  the column NOT NULL contract while
 *                                  removing the marketing/analytics
 *                                  history)
 *   - `password_hash` → `NULL` (defence in depth — even if the row
 *                                survives a backup leak, the bcrypt
 *                                hash is gone so credential stuffing
 *                                from leaked dumps is not amplified)
 *
 * `deleted_at` is left untouched so the row stays in the soft-delete
 * "tombstone" state forever. A second invocation against the same
 * row is a no-op (the WHERE clause guards on `email IS NOT NULL`).
 *
 * Operations note: the function caps each invocation at
 * `options.batchLimit` rows so a sudden backlog (e.g. after a long
 * cron outage) does not lock the table for minutes. The cron will
 * re-fire on its next tick to drain the rest.
 */
export async function anonymizeExpiredUsers(
  deps: SqlExecutor,
  options: {
    readonly anonymizeAfterDays?: number;
    readonly batchLimit?: number;
    readonly clock?: PurgeClock;
  } = {},
): Promise<AnonymizeUsersResult> {
  const days = options.anonymizeAfterDays ?? DEFAULT_USER_ANONYMIZE_AFTER_DAYS;
  const limit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const clock = options.clock ?? realClock;
  const cutoff = new Date(clock.now().getTime() - days * 24 * 60 * 60 * 1000);

  // Guard with a CTE so the LIMIT applies inside the UPDATE — bare
  // `UPDATE ... LIMIT` is a Postgres syntax error. The IS NOT NULL
  // guard on `email` makes the operation idempotent (a second pass
  // re-selects 0 rows even if the cutoff has not advanced).
  const query = `
        WITH expired AS (
            SELECT id FROM users
            WHERE deleted_at IS NOT NULL
              AND deleted_at < $1
              AND email IS NOT NULL
            ORDER BY deleted_at ASC
            LIMIT $2
        )
        UPDATE users
        SET email = NULL,
            display_name = '[deleted]',
            avatar_url = NULL,
            consents = '{}'::jsonb,
            password_hash = NULL
        WHERE id IN (SELECT id FROM expired)
    `;

  const anonymizedCount = await deps.execute(query, [cutoff, limit]);
  return { anonymizedCount, hasMore: anonymizedCount === limit };
}

/* ------------------------------------------------------------------ */
/*  S5-005 — purge published outbox rows                               */
/* ------------------------------------------------------------------ */

export interface PurgeOutboxResult {
  readonly deletedCount: number;
}

/**
 * Delete `outbox` rows whose `published_at` is older than the
 * retention window. Unpublished rows are NEVER deleted — the drain
 * worker (`packages/api/src/events/drain-scheduled.ts`) will keep
 * retrying them until either a publish succeeds or an operator
 * intervenes.
 *
 * The 7-day default matches the Cloudflare Queues retry-budget
 * window (5 retries × backoff capped at 24 h) plus a 2-day buffer
 * for incident postmortem visibility. Every row published more
 * than a week ago is irrelevant for live ops.
 */
export async function purgeExpiredOutbox(
  deps: SqlExecutor,
  options: {
    readonly retentionDays?: number;
    readonly batchLimit?: number;
    readonly clock?: PurgeClock;
  } = {},
): Promise<PurgeOutboxResult> {
  const days = options.retentionDays ?? DEFAULT_OUTBOX_RETENTION_DAYS;
  const limit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const clock = options.clock ?? realClock;
  const cutoff = new Date(clock.now().getTime() - days * 24 * 60 * 60 * 1000);

  const query = `
        DELETE FROM outbox
        WHERE id IN (
            SELECT id FROM outbox
            WHERE published_at IS NOT NULL
              AND published_at < $1
            ORDER BY published_at ASC
            LIMIT $2
        )
    `;

  const deletedCount = await deps.execute(query, [cutoff, limit]);
  return { deletedCount };
}

/* ------------------------------------------------------------------ */
/*  S5-006 — purge expired export_jobs                                 */
/* ------------------------------------------------------------------ */

export interface PurgeExportJobsResult {
  readonly deletedCount: number;
}

/**
 * Delete terminal `export_jobs` rows older than the retention
 * window. Only `completed` and `failed` rows are eligible —
 * `pending` / `running` jobs may still be in flight on the bus and
 * deleting them would lose the user-facing status.
 *
 * The 90-day default matches the audit-trail support window: a
 * user who reaches out about a missing export within three months
 * still has a row to reference. After 90 days, the underlying R2
 * archive has been gone for nearly that long anyway (signed-URL
 * TTL is 72 h).
 */
export async function purgeExpiredExportJobs(
  deps: SqlExecutor,
  options: {
    readonly retentionDays?: number;
    readonly batchLimit?: number;
    readonly clock?: PurgeClock;
  } = {},
): Promise<PurgeExportJobsResult> {
  const days = options.retentionDays ?? DEFAULT_EXPORT_JOBS_RETENTION_DAYS;
  const limit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const clock = options.clock ?? realClock;
  const cutoff = new Date(clock.now().getTime() - days * 24 * 60 * 60 * 1000);

  const query = `
        DELETE FROM export_jobs
        WHERE id IN (
            SELECT id FROM export_jobs
            WHERE status IN ('completed', 'failed')
              AND requested_at < $1
            ORDER BY requested_at ASC
            LIMIT $2
        )
    `;

  const deletedCount = await deps.execute(query, [cutoff, limit]);
  return { deletedCount };
}

/* ------------------------------------------------------------------ */
/*  Aggregate runner                                                   */
/* ------------------------------------------------------------------ */

/**
 * Result envelope for {@link runRgpdMaintenanceCycle}.
 *
 * Field naming mirrors the per-job results so the cron's structured
 * log line stays self-describing.
 */
export interface RgpdMaintenanceResult {
  readonly anonymizedUsers: number;
  /** True when the anonymization batch was full — signals a backlog. */
  readonly anonymizedUsersHasMore: boolean;
  readonly purgedOutbox: number;
  readonly purgedExportJobs: number;
}

/**
 * Run all three jobs sequentially. Failures in any one job are
 * isolated — the next jobs still run, and the failure surfaces via
 * a thrown error AFTER all jobs have attempted. This matches the
 * "best effort each tick" pattern used by the outbox drain.
 *
 * The function is intentionally simple: no parallelism, no
 * retry-on-deadlock loop. Postgres is happy with three sequential
 * batched DELETEs / UPDATEs of 500 rows each.
 */
export async function runRgpdMaintenanceCycle(
  deps: SqlExecutor,
  options: {
    readonly anonymizeAfterDays?: number;
    readonly outboxRetentionDays?: number;
    readonly exportJobsRetentionDays?: number;
    readonly batchLimit?: number;
    readonly clock?: PurgeClock;
  } = {},
): Promise<RgpdMaintenanceResult> {
  const errors: Error[] = [];

  let anonymizedUsers = 0;
  let anonymizedUsersHasMore = false;
  try {
    const r = await anonymizeExpiredUsers(deps, {
      ...(options.anonymizeAfterDays !== undefined
        ? { anonymizeAfterDays: options.anonymizeAfterDays }
        : {}),
      ...(options.batchLimit !== undefined ? { batchLimit: options.batchLimit } : {}),
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
    });
    anonymizedUsers = r.anonymizedCount;
    anonymizedUsersHasMore = r.hasMore;
  } catch (err) {
    errors.push(err instanceof Error ? err : new Error(String(err)));
  }

  let purgedOutbox = 0;
  try {
    const r = await purgeExpiredOutbox(deps, {
      ...(options.outboxRetentionDays !== undefined
        ? { retentionDays: options.outboxRetentionDays }
        : {}),
      ...(options.batchLimit !== undefined ? { batchLimit: options.batchLimit } : {}),
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
    });
    purgedOutbox = r.deletedCount;
  } catch (err) {
    errors.push(err instanceof Error ? err : new Error(String(err)));
  }

  let purgedExportJobs = 0;
  try {
    const r = await purgeExpiredExportJobs(deps, {
      ...(options.exportJobsRetentionDays !== undefined
        ? { retentionDays: options.exportJobsRetentionDays }
        : {}),
      ...(options.batchLimit !== undefined ? { batchLimit: options.batchLimit } : {}),
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
    });
    purgedExportJobs = r.deletedCount;
  } catch (err) {
    errors.push(err instanceof Error ? err : new Error(String(err)));
  }

  if (errors.length > 0) {
    // Surface the first error verbatim and append the others as
    // serialised messages so the structured logger captures every
    // failure on a single line.
    const head = errors[0]!;
    const tail = errors
      .slice(1)
      .map((e) => e.message)
      .join('; ');
    throw new Error(
      tail.length > 0
        ? `rgpd maintenance cycle: ${head.message}; subsequent: ${tail}`
        : `rgpd maintenance cycle: ${head.message}`,
    );
  }

  return { anonymizedUsers, anonymizedUsersHasMore, purgedOutbox, purgedExportJobs };
}
