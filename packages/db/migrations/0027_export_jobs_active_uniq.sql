-- Issue #462: replace non-unique partial index with a UNIQUE partial index
-- enforcing at-most-one active export per user. The INSERT in
-- create() will now raise SQLSTATE 23505 on a concurrent enqueue,
-- which the adapter catches and converts into an idempotent dedup.

-- Resolve any pre-existing duplicates produced by the old race window:
-- keep the most recently-requested active row per user and mark the
-- rest as 'failed' so the UNIQUE CREATE below never conflicts.
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY user_id ORDER BY requested_at DESC
           ) AS rn
    FROM export_jobs
    WHERE status IN ('pending', 'running')
)
UPDATE export_jobs
    SET status = 'failed',
        error  = 'deduplicated during migration 0027 (export_jobs_user_active_uniq)'
    WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
--> statement-breakpoint
DROP INDEX IF EXISTS "export_jobs_user_active_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "export_jobs_user_active_uniq"
    ON "export_jobs" ("user_id")
    WHERE status IN ('pending', 'running');
