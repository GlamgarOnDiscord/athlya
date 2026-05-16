/**
 * Drizzle-backed `ExportJobStore` for `@athlya/members/export`.
 *
 * Backs the RGPD export state machine on the `export_jobs` table
 * (see `packages/db/src/schema/export_jobs.ts`). Every method maps
 * to one SQL statement; the state transitions themselves are
 * enforced by the service (pending → running → completed | failed).
 *
 * Dedup lookup (`findActiveByUser`) uses the partial index
 * `export_jobs_user_active_idx` on the `pending` / `running` slice,
 * so the query is O(1) even on a table with years of history.
 *
 * Idempotency:
 *   - `create` is NOT retry-safe; the service guards against a
 *     duplicate insert via `findActiveByUser` before calling
 *     `create`, and the `users_export_active_idx` tracks only the
 *     pending/running rows so we never race with a completed/failed
 *     clone. The small (1-RTT) race window is documented in the
 *     service and considered acceptable.
 *   - `markRunning` / `markCompleted` / `markFailed` are idempotent
 *     by design — re-running a transition that already landed is a
 *     no-op because the WHERE clause filters on the source state.
 *
 * @see Requirements 4.1, 4.2, 4.3, 20.1.
 */

import { exportJobs } from '@athlya/db/schema';
import { and, desc, eq, inArray } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';

import type { AthlyaDbAny } from '@athlya/db/client';
import type {
    ExportJobRecord,
    ExportJobStore,
} from '@athlya/members';

/**
 * Factory — produces an `ExportJobStore` bound to the supplied
 * Drizzle instance.
 */
export function createDrizzleExportJobStore(db: AthlyaDbAny): ExportJobStore {
    return {
        async create(jobId, userId, requestedAt) {
            await withConnectionRetry(async () => {
                await db.insert(exportJobs).values({
                    id: jobId,
                    userId,
                    status: 'pending',
                    requestedAt,
                });
            });
        },

        async markRunning(jobId, startedAt) {
            await withConnectionRetry(async () => {
                await db
                    .update(exportJobs)
                    .set({ status: 'running', startedAt })
                    .where(
                        and(
                            eq(exportJobs.id, jobId),
                            eq(exportJobs.status, 'pending'),
                        ),
                    );
            });
        },

        async markCompleted(
            jobId,
            completedAt,
            downloadUrl,
            downloadExpiresAt,
        ) {
            await withConnectionRetry(async () => {
                await db
                    .update(exportJobs)
                    .set({
                        status: 'completed',
                        completedAt,
                        downloadUrl,
                        downloadExpiresAt,
                    })
                    .where(
                        and(
                            eq(exportJobs.id, jobId),
                            eq(exportJobs.status, 'running'),
                        ),
                    );
            });
        },

        async markFailed(jobId, error) {
            await withConnectionRetry(async () => {
                await db
                    .update(exportJobs)
                    .set({ status: 'failed', error })
                    .where(
                        and(
                            eq(exportJobs.id, jobId),
                            inArray(exportJobs.status, ['pending', 'running']),
                        ),
                    );
            });
        },

        async get(jobId) {
            const rows = await withConnectionRetry(() =>
                db
                    .select()
                    .from(exportJobs)
                    .where(eq(exportJobs.id, jobId))
                    .limit(1),
            );
            const row = rows[0];
            return row === undefined ? null : toExportJobRecord(row);
        },

        async findActiveByUser(userId) {
            const rows = await withConnectionRetry(() =>
                db
                    .select({ id: exportJobs.id })
                    .from(exportJobs)
                    .where(
                        and(
                            eq(exportJobs.userId, userId),
                            inArray(exportJobs.status, ['pending', 'running']),
                        ),
                    )
                    .orderBy(desc(exportJobs.requestedAt))
                    .limit(1),
            );
            return rows[0]?.id ?? null;
        },
    };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function toExportJobRecord(
    row: typeof exportJobs.$inferSelect,
): ExportJobRecord {
    return {
        id: row.id,
        userId: row.userId,
        status: row.status,
        requestedAt: row.requestedAt.toISOString(),
        startedAt: row.startedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        error: row.error,
        downloadUrl: row.downloadUrl,
        downloadExpiresAt: row.downloadExpiresAt?.toISOString() ?? null,
    };
}
