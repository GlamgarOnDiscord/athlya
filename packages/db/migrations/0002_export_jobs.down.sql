-- =====================================================================
-- Rollback for 0002_export_jobs.sql
--
-- Reverses every object created by the export_jobs migration, in
-- reverse order:
--
--   1. Drop the `export_jobs_read_own` RLS policy.
--   2. Disable RLS on the table (`NO FORCE` then `DISABLE`).
--   3. Drop the partial index (redundant with DROP TABLE CASCADE, but
--      explicit for reviewers and for the case where the index was
--      retained by a later hot-fix).
--   4. Drop the table with CASCADE (catches any FK a downstream
--      migration may have added pointing into `export_jobs`).
--   5. Drop the `export_job_status` enum type — after the column
--      using it is gone.
--
-- Idempotent throughout via `IF EXISTS`.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Drop the RLS policy
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "export_jobs_read_own" ON "export_jobs";

-- ---------------------------------------------------------------------
-- 2. Disable RLS on the table
-- ---------------------------------------------------------------------

ALTER TABLE IF EXISTS "export_jobs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "export_jobs" DISABLE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 3. Drop the partial index (redundant with DROP TABLE CASCADE)
-- ---------------------------------------------------------------------

DROP INDEX IF EXISTS "export_jobs_user_active_idx";

-- ---------------------------------------------------------------------
-- 4. Drop the table
-- ---------------------------------------------------------------------

DROP TABLE IF EXISTS "export_jobs" CASCADE;

-- ---------------------------------------------------------------------
-- 5. Drop the enum type (after its column is gone with the table)
-- ---------------------------------------------------------------------

DROP TYPE IF EXISTS "public"."export_job_status";
