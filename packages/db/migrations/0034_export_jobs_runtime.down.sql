-- Rollback for 0034_export_jobs_runtime.sql (issue #498).
DROP FUNCTION IF EXISTS export_job_rows(uuid, text, text, integer);
DROP FUNCTION IF EXISTS export_job_profile(uuid);
DROP FUNCTION IF EXISTS export_job_fail(uuid, uuid, text);
DROP FUNCTION IF EXISTS export_job_complete(uuid, uuid, text, timestamptz);
DROP FUNCTION IF EXISTS export_job_claim(uuid);
DROP FUNCTION IF EXISTS export_job_get(uuid);
DROP FUNCTION IF EXISTS export_iso(timestamptz);
REVOKE UPDATE ("status", "started_at", "completed_at", "error", "download_url", "download_expires_at")
    ON "export_jobs" FROM athlya_owner;
-- Dropping the column below also drops its privileges; the guard keeps a
-- retried rollback from failing once the column is gone.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'export_jobs'
                  AND column_name = 'claim_token') THEN
        REVOKE UPDATE ("claim_token") ON "export_jobs" FROM athlya_owner;
    END IF;
END
$$;
REVOKE SELECT ON "export_jobs" FROM athlya_owner;
DROP POLICY IF EXISTS "export_jobs_insert_own" ON "export_jobs";
ALTER TABLE "export_jobs" DROP COLUMN IF EXISTS "claim_token";
