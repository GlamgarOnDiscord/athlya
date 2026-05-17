/**
 * Audit-log anonymisation cron driver — Sprint-6 Slice 6.2
 * (Vague 34, audit finding S5-003 [HIGH][PROD-RISK] partial).
 *
 * The Postgres function `anonymize_user_audit(target_user uuid)`
 * was shipped in migration `0003_audit_anonymization.sql`. The
 * `@athlya/members` `anonymizeAuditLog(userId, deps)` primitive
 * wraps it via the `DeletionRepo.anonymizeAuditRows` adapter. What
 * was missing (S5-003) was a CRON-driven driver that scans for
 * users whose 30-day grace window has elapsed and invokes the
 * primitive for each. This module is that driver — pure, testable,
 * framework-free.
 *
 * Production wiring (still pending — needs a `CRON_DB_URL` binding
 * pointing at the privileged `athlya_cron` Postgres role):
 *
 * ```ts
 * // worker.ts scheduled handler
 * scheduled(event, env, ctx) {
 *   ctx.waitUntil(
 *     runAuditAnonymisationCycle({
 *       executeSql: makeExecutor(env.CRON_DB_URL),
 *       anonymizeOne: (userId) => anonymizeAuditLog(userId, deps),
 *     }),
 *   );
 * }
 * ```
 *
 * Until that binding lands, this file ships the deterministic
 * runner so the team can drive it manually via a wrangler CLI
 * one-shot (`wrangler triggers cron --test`) and exercise the
 * full chain in staging before the binding is formal.
 *
 * @see packages/db/migrations/0003_audit_anonymization.sql — `anonymize_user_audit`
 * @see packages/members/src/cascade.ts — `anonymizeAuditLog`
 * @see docs/security/audit-S5-rgpd.md S5-003
 */

/* ------------------------------------------------------------------ */
/*  Contract                                                           */
/* ------------------------------------------------------------------ */

/** Same minimal SQL executor surface used by `rgpd-purge.ts`. */
export interface AuditAnonymizeSql {
  /**
   * Execute a SELECT query and return the rows. Implementations:
   * a Drizzle `db.execute(sql).then(r => r.rows)` adaptor in
   * production, an in-memory recorder in tests.
   *
   * `params` is positional; placeholder syntax is `$1`, `$2`, …
   * to stay driver-agnostic.
   */
  selectRows<T>(query: string, params: readonly unknown[]): Promise<T[]>;
}

/**
 * Per-user anonymisation step. Production binds this to
 * `(userId) => anonymizeAuditLog(userId, deps)` from
 * `@athlya/members/cascade`. Tests inject a `vi.fn()` that records
 * calls.
 *
 * The function MUST be idempotent — `anonymize_user_audit` itself
 * is a no-op when the rows are already anonymised.
 */
export type AnonymizeOneFn = (userId: string) => Promise<{
  readonly anonymizedRows: number;
}>;

export interface AuditAnonymizeDeps {
  readonly executeSql: AuditAnonymizeSql;
  readonly anonymizeOne: AnonymizeOneFn;
}

/** Optional clock for deterministic testing. */
export interface AuditAnonymizeClock {
  now(): Date;
}

const realClock: AuditAnonymizeClock = { now: () => new Date() };

/** Default 30-day grace window per Req 5.3 + audit finding S5-003. */
export const DEFAULT_ANONYMIZE_GRACE_DAYS = 30;

/**
 * Hard cap on how many users are processed per cron tick. Same
 * rationale as `DEFAULT_BATCH_LIMIT` in `rgpd-purge.ts` — a
 * sudden backlog after a cron outage must not lock the table for
 * minutes; subsequent ticks drain the rest.
 */
export const DEFAULT_USER_BATCH_LIMIT = 100;

/* ------------------------------------------------------------------ */
/*  Runner                                                             */
/* ------------------------------------------------------------------ */

/**
 * Result envelope summarising one cron tick.
 *
 * `processed` counts ATTEMPTS, not just successes. `succeeded`
 * counts the calls that returned without throwing. `errors`
 * captures every failure verbatim so on-call can dig.
 */
export interface AuditAnonymizeResult {
  readonly processed: number;
  readonly succeeded: number;
  readonly errors: { readonly userId: string; readonly error: string }[];
  readonly anonymizedRowsTotal: number;
}

/**
 * Run one cron tick of audit-log anonymisation.
 *
 * Behaviour:
 *
 *   1. SELECT users whose `deleted_at` is older than the grace
 *      window AND whose audit rows have NOT been anonymised yet
 *      (signalled by `users.audit_anonymized_at IS NULL`).
 *   2. For each user, invoke `anonymizeOne(userId)` — wraps the
 *      Postgres `anonymize_user_audit` SECURITY DEFINER function
 *      that strips `actor_id`, `metadata.email`, `metadata.userAgent`,
 *      `metadata.ip` while preserving the row count for forensic
 *      replay.
 *   3. UPDATE `users.audit_anonymized_at = now()` on success so
 *      the next tick does not re-target the same user.
 *   4. Aggregate counts + errors. Failures are isolated per user
 *      — one user's exception does NOT abort the batch.
 *
 * Exposed as a free function (rather than a class method) so the
 * eventual cron handler in `worker.ts` reads as a single
 * `await runAuditAnonymisationCycle(deps)` call.
 */
export async function runAuditAnonymisationCycle(
  deps: AuditAnonymizeDeps,
  options: {
    readonly graceDays?: number;
    readonly batchLimit?: number;
    readonly clock?: AuditAnonymizeClock;
  } = {},
): Promise<AuditAnonymizeResult> {
  const days = options.graceDays ?? DEFAULT_ANONYMIZE_GRACE_DAYS;
  const limit = options.batchLimit ?? DEFAULT_USER_BATCH_LIMIT;
  const clock = options.clock ?? realClock;
  const cutoff = new Date(clock.now().getTime() - days * 24 * 60 * 60 * 1000);

  // Select eligible users. The `audit_anonymized_at` column is
  // added in a follow-up migration (deferred — for now, the
  // query treats `NULL` as "not yet processed" and existing
  // builds without that column will need the migration shipped
  // first). Until then this query is a no-op safety net.
  const eligibleQuery = `
        SELECT id::text AS user_id
        FROM users
        WHERE deleted_at IS NOT NULL
          AND deleted_at < $1
          AND COALESCE(audit_anonymized_at, '1970-01-01'::timestamptz) < deleted_at
        ORDER BY deleted_at ASC
        LIMIT $2
    `;

  const eligible = await deps.executeSql.selectRows<{ user_id: string }>(eligibleQuery, [
    cutoff,
    limit,
  ]);

  let succeeded = 0;
  let anonymizedRowsTotal = 0;
  const errors: { userId: string; error: string }[] = [];

  for (const row of eligible) {
    try {
      const result = await deps.anonymizeOne(row.user_id);
      anonymizedRowsTotal += result.anonymizedRows;
      succeeded += 1;
      // Stamp the watermark so the next tick skips this user.
      // The UPDATE is idempotent — re-running it on a
      // already-stamped row is fine.
      await deps.executeSql.selectRows(
        `UPDATE users SET audit_anonymized_at = NOW() WHERE id = $1::uuid`,
        [row.user_id],
      );
    } catch (err) {
      errors.push({
        userId: row.user_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    processed: eligible.length,
    succeeded,
    errors,
    anonymizedRowsTotal,
  };
}
