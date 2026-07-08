-- Issue #462: replace non-unique partial index with a UNIQUE partial index
-- enforcing at-most-one active export per user. The INSERT in
-- create() will now raise SQLSTATE 23505 on a concurrent enqueue,
-- which the adapter catches and converts into an idempotent dedup.

DROP INDEX IF EXISTS "export_jobs_user_active_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "export_jobs_user_active_uniq"
    ON "export_jobs" ("user_id")
    WHERE status IN ('pending', 'running');
