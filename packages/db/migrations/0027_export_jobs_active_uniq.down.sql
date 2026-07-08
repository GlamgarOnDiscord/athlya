DROP INDEX IF EXISTS "export_jobs_user_active_uniq";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "export_jobs_user_active_idx"
    ON "export_jobs" ("user_id", "requested_at")
    WHERE status IN ('pending', 'running');
