-- Rollback for 0034_export_jobs_runtime.sql (issue #498).
DROP FUNCTION IF EXISTS export_job_rows(uuid, text, text, integer);
DROP FUNCTION IF EXISTS export_job_profile(uuid);
DROP FUNCTION IF EXISTS export_job_fail(uuid, text);
DROP FUNCTION IF EXISTS export_job_complete(uuid, text, timestamptz);
DROP FUNCTION IF EXISTS export_job_claim(uuid);
DROP FUNCTION IF EXISTS export_job_get(uuid);
DROP FUNCTION IF EXISTS export_iso(timestamptz);
REVOKE UPDATE ("status", "started_at", "completed_at", "error", "download_url", "download_expires_at")
    ON "export_jobs" FROM athlya_owner;
REVOKE SELECT ON "export_jobs" FROM athlya_owner;
DROP POLICY IF EXISTS "export_jobs_insert_own" ON "export_jobs";
