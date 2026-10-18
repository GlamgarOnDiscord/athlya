/**
 * Drizzle-backed `ExportJobStore` for `@athlya/members/export`.
 *
 * Backs the RGPD export state machine on the `export_jobs` table
 * (see `packages/db/src/schema/export_jobs.ts`). Every method maps
 * to one SQL statement; the state transitions themselves are
 * enforced by the service (pending → running → completed | failed).
 *
 * Dedup lookup (`findActiveByUser`) uses the unique partial index
 * `export_jobs_user_active_uniq` on the `pending` / `running` slice,
 * so the query is O(1) even on a table with years of history.
 *
 * Idempotency:
 *   - `create` catches SQLSTATE 23505 from the unique partial index
 *     and converts it into an idempotent dedup: it re-reads the
 *     existing active row via `findActiveByUser` and returns that id
 *     so the caller can short-circuit without publishing a duplicate
 *     event (issue #462).
 *   - `markRunning` / `markCompleted` / `markFailed` are idempotent
 *     by design — re-running a transition that already landed is a
 *     no-op because the WHERE clause filters on the source state;
 *     `markRunning` returns a claim token only to the caller that won
 *     the claim, and completion / failure require that token.
 *
 * @see Requirements 4.1, 4.2, 4.3, 20.1.
 */

import { withTenantHttp } from '@athlya/db';
import { isPostgresUniqueViolation } from '@athlya/db/errors';
import { exportJobs } from '@athlya/db/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { noteOutboxWrite } from '../events/outbox-kick.js';

import { withConnectionRetry } from './db-retry.js';
import { queryRows, toDateOrNull } from './service-functions.js';

import type { AthlyaDbAny, AthlyaDbHttp, TenantClaims } from '@athlya/db/client';
import type { ExportJobRecord, ExportJobStore } from '@athlya/members';

/**
 * Worker-side `ExportJobStore` for the `members.export.requested` queue
 * consumer (issue #498). The consumer runs as `athlya_app` with no
 * tenant claims, so every transition goes through the SECURITY DEFINER
 * functions of migration 0034: `export_job_claim` is the atomic
 * `pending → running` claim with a 15 min lease that mints a claim
 * token; completion / failure require the current token, so a stale run
 * whose lease was reclaimed cannot touch the newer run. The worker never
 * enqueues, so `create` / `findActiveByUser` refuse.
 */
export function createExportJobWorkerStore(db: AthlyaDbAny): ExportJobStore {
  return {
    create() {
      return Promise.reject(new Error('export worker store cannot enqueue jobs'));
    },

    async markRunning(jobId) {
      const rows = await queryRows<{ claim_token: string | null }>(
        db,
        sql`SELECT export_job_claim(${jobId}::uuid) AS claim_token`,
      );
      return rows[0]?.claim_token ?? null;
    },

    async markCompleted(jobId, claimToken, _completedAt, downloadUrl, downloadExpiresAt) {
      const rows = await queryRows<{ completed: boolean }>(
        db,
        sql`SELECT export_job_complete(${jobId}::uuid, ${claimToken}::uuid, ${downloadUrl}, ${downloadExpiresAt.toISOString()}::timestamptz) AS completed`,
      );
      return rows[0]?.completed === true;
    },

    async markFailed(jobId, claimToken, error) {
      await queryRows(
        db,
        sql`SELECT export_job_fail(${jobId}::uuid, ${claimToken}::uuid, ${error})`,
      );
    },

    async get(jobId) {
      const rows = await queryRows<WorkerJobRow>(
        db,
        sql`SELECT * FROM export_job_get(${jobId}::uuid)`,
      );
      const row = rows[0];
      return row === undefined ? null : workerRowToRecord(row);
    },

    findActiveByUser() {
      return Promise.reject(new Error('export worker store cannot look up jobs by user'));
    },
  };
}

/* ------------------------------------------------------------------ */
/*  HTTP-driver variant                                                */
/* ------------------------------------------------------------------ */

/**
 * HTTP-driver variant — each query runs inside a `withTenantHttp`
 * batch so `SET LOCAL app.*` activates RLS policies before the
 * business statement executes.
 */
export function createDrizzleExportJobStoreHttp(
  db: AthlyaDbHttp,
  claims: TenantClaims,
): ExportJobStore {
  const store: ExportJobStore = {
    async create(jobId, userId, requestedAt, requestedEvent) {
      try {
        if (requestedEvent === undefined) {
          await withConnectionRetry(() =>
            withTenantHttp(
              db,
              claims,
              db.insert(exportJobs).values({
                id: jobId,
                userId,
                status: 'pending',
                requestedAt,
              }),
            ),
          );
        } else {
          // Issue #498 — the job row and its `members.export.requested`
          // outbox event are one statement in one tenant transaction
          // (`export_jobs_insert_own` + `outbox_insert_tenant`), so a
          // queue outage can no longer strand the job in `pending`.
          await withConnectionRetry(() =>
            withTenantHttp(
              db,
              claims,
              db.execute(sql`
                WITH job AS (
                  INSERT INTO export_jobs (id, user_id, status, requested_at)
                  VALUES (${jobId}::uuid, ${userId}::uuid, 'pending', ${requestedAt.toISOString()}::timestamptz)
                  RETURNING id
                )
                INSERT INTO outbox (event_id, event_type, payload, occurred_at)
                SELECT ${requestedEvent.id}, ${requestedEvent.type}, ${JSON.stringify(requestedEvent)}::jsonb,
                       ${requestedEvent.occurredAt}::timestamptz
                  FROM job
              `),
            ),
          );
          noteOutboxWrite(requestedEvent.type);
        }
        return jobId;
      } catch (err) {
        if (isPostgresUniqueViolation(err)) {
          const existing = await store.findActiveByUser(userId);
          if (existing !== null) return existing;
        }
        throw err;
      }
    },

    async markRunning(jobId, startedAt) {
      const claimToken = crypto.randomUUID();
      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db
            .update(exportJobs)
            .set({ status: 'running', startedAt, claimToken })
            .where(and(eq(exportJobs.id, jobId), eq(exportJobs.status, 'pending')))
            .returning({ id: exportJobs.id }),
        ),
      );
      return rows.length > 0 ? claimToken : null;
    },

    async markCompleted(jobId, claimToken, completedAt, downloadUrl, downloadExpiresAt) {
      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db
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
                eq(exportJobs.claimToken, claimToken),
              ),
            )
            .returning({ id: exportJobs.id }),
        ),
      );
      return rows.length > 0;
    },

    async markFailed(jobId, claimToken, error) {
      await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db
            .update(exportJobs)
            .set({ status: 'failed', error })
            .where(
              and(
                eq(exportJobs.id, jobId),
                eq(exportJobs.status, 'running'),
                eq(exportJobs.claimToken, claimToken),
              ),
            ),
        ),
      );
    },

    async get(jobId) {
      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db.select().from(exportJobs).where(eq(exportJobs.id, jobId)).limit(1),
        ),
      );
      const row = rows[0];
      return row === undefined ? null : toExportJobRecord(row);
    },

    async findActiveByUser(userId) {
      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
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
        ),
      );
      return rows[0]?.id ?? null;
    },
  };
  return store;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function toExportJobRecord(row: typeof exportJobs.$inferSelect): ExportJobRecord {
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
    claimToken: row.claimToken,
  };
}

/** Row returned by `export_job_get` (snapshot of `export_jobs`). */
interface WorkerJobRow {
  readonly id: string;
  readonly user_id: string;
  readonly status: ExportJobRecord['status'];
  readonly requested_at: Date | string;
  readonly started_at: Date | string | null;
  readonly completed_at: Date | string | null;
  readonly error: string | null;
  readonly download_url: string | null;
  readonly download_expires_at: Date | string | null;
}

function isoOrNull(value: Date | string | null): string | null {
  return toDateOrNull(value)?.toISOString() ?? null;
}

function workerRowToRecord(row: WorkerJobRow): ExportJobRecord {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    requestedAt: isoOrNull(row.requested_at) ?? '',
    startedAt: isoOrNull(row.started_at),
    completedAt: isoOrNull(row.completed_at),
    error: row.error,
    downloadUrl: row.download_url,
    downloadExpiresAt: isoOrNull(row.download_expires_at),
  };
}
