-- Rollback for 0019_cron_role_nobypassrls.sql
-- Restores BYPASSRLS on athlya_cron and removes the cron-specific RLS policies.

DROP POLICY IF EXISTS "users_cron_select" ON "users";
DROP POLICY IF EXISTS "users_cron_update" ON "users";
DROP POLICY IF EXISTS "outbox_cron_select" ON "outbox";
DROP POLICY IF EXISTS "outbox_cron_delete" ON "outbox";
DROP POLICY IF EXISTS "export_jobs_cron_select" ON "export_jobs";
DROP POLICY IF EXISTS "export_jobs_cron_delete" ON "export_jobs";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_cron') THEN
    REVOKE SELECT ON outbox FROM athlya_cron;
    REVOKE SELECT ON export_jobs FROM athlya_cron;
    ALTER ROLE athlya_cron BYPASSRLS;
  END IF;
END
$$;
