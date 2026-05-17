/**
 * `export_jobs` — RGPD data-export job tracking.
 *
 * Column choices:
 *   - `user_id` is the subject of the export. Indexed (partial, on the
 *     `pending` / `running` slice) so the dedup path in
 *     `enqueueExport` can look up an active job in O(1).
 *   - `status` is an enum tracking the state machine declared in
 *     `enums.ts::exportJobStatusEnum`. The state transitions are
 *     enforced in code (`markRunning` / `markCompleted` / `markFailed`)
 *     — the database intentionally does not express the predecessor
 *     relation because jobs are claimed by a single worker at a time
 *     via `SELECT ... FOR UPDATE`.
 *   - `requested_at` is stamped on insert and never updated.
 *   - `started_at`, `completed_at` are nullable timestamps flipped by
 *     the state-change helpers.
 *   - `download_url` + `download_expires_at` hold the Cloudflare R2
 *     pre-signed URL produced on the `completed` path. The URL lives
 *     exactly 72 hours after issuance (Requirement 4.2); consumers
 *     reading the table MUST re-check `download_expires_at > now()`
 *     before serving the link.
 *   - `error` carries a short human-readable reason on the `failed`
 *     path. The worker logs the full stack to the OTel backend
 *     (Axiom by default); this column
 *     is for the audit trail, not for debugging.
 *
 * Related requirements: 4.1 (enqueue returns a job id), 4.2 (ZIP
 * archive + signed URL with 72 h TTL), 4.3 (delivery SLA), 4.4 (archive
 * content scope).
 */

import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { createdAt, uuidPrimaryKey } from './_shared.js';
import { exportJobStatusEnum } from './enums.js';
import { users } from './users.js';

export const exportJobs = pgTable(
  'export_jobs',
  {
    id: uuidPrimaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: exportJobStatusEnum('status').notNull().default('pending'),
    /**
     * `requested_at` is the wall-clock timestamp the user's request
     * entered the system. Used by the 48-hour SLO dashboard
     * (Requirement 4.3) and by the dedup query to pick the most
     * recent pending/running row when several exist.
     */
    requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    /**
     * Short human-readable reason stamped on the `failed` path.
     * `null` while the job is still pending / running / completed.
     */
    error: text('error'),
    /**
     * Signed R2 URL issued once the archive is ready. Consumers
     * MUST re-check {@link downloadExpiresAt} before handing the
     * URL to the user — the 72 h TTL is the authoritative window,
     * even when the URL string is technically still well-formed.
     */
    downloadUrl: text('download_url'),
    downloadExpiresAt: timestamp('download_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: createdAt(),
  },
  (table) => [
    /**
     * Dedup lookup: "does this user have an active export in
     * flight?". Partial index on the `pending` / `running` slice
     * keeps the index tiny (completed/failed rows dominate the
     * table after a few weeks).
     */
    index('export_jobs_user_active_idx')
      .on(table.userId, table.requestedAt)
      .where(sql`status in ('pending', 'running')`),
  ],
);

export type ExportJobRow = typeof exportJobs.$inferSelect;
export type ExportJobInsert = typeof exportJobs.$inferInsert;
