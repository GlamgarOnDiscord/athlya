/**
 * Expired idempotency-key purge (audit finding S4-011).
 *
 * `idempotency_keys` rows live 24 h (Requirement 20.2): lookups ignore
 * a row once `expires_at` has passed, but the row itself, cached
 * response included, used to stay forever. Each scheduled tick now
 * deletes a bounded batch of expired rows through
 * `idempotency_purge_expired(p_limit)` (migration 0047), a SECURITY
 * DEFINER function granted to `athlya_cron` only. The cron role has no
 * grant on the table itself, so it can never read a cached response.
 *
 * The batch is larger than the RGPD purges' 100 rows: one row is
 * written per idempotent mutation, so the backlog grows with traffic,
 * and the delete is an index range scan on `expires_at`.
 *
 * @see packages/db/migrations/0047_idempotency_keys_purge.sql
 */

/** Rows deleted per tick at most. The function refuses more than 10 000. */
export const DEFAULT_IDEMPOTENCY_PURGE_LIMIT = 1000;

/** Read surface of the cron executor (`buildCronSqlExecutor`). */
export interface IdempotencyPurgeExecutor {
  selectRows<T>(query: string, params: readonly unknown[]): Promise<T[]>;
}

export interface IdempotencyPurgeResult {
  readonly deletedCount: number;
  /** True when the batch was full: more expired rows are left for the next tick. */
  readonly hasMore: boolean;
}

/**
 * Delete up to `batchLimit` expired `idempotency_keys` rows, oldest
 * first. Throws when the database call fails; the scheduled runner
 * isolates the failure from the other maintenance jobs.
 */
export async function purgeExpiredIdempotencyKeys(
  deps: IdempotencyPurgeExecutor,
  options: { readonly batchLimit?: number } = {},
): Promise<IdempotencyPurgeResult> {
  const limit = options.batchLimit ?? DEFAULT_IDEMPOTENCY_PURGE_LIMIT;
  const rows = await deps.selectRows<{ deleted: number | string | null }>(
    'SELECT idempotency_purge_expired($1::integer) AS deleted',
    [limit],
  );
  const deletedCount = Number(rows[0]?.deleted ?? 0);
  if (!Number.isInteger(deletedCount) || deletedCount < 0) {
    throw new Error(`idempotency purge: unexpected count ${String(rows[0]?.deleted)}`);
  }
  return { deletedCount, hasMore: deletedCount >= limit };
}
