DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_cron') THEN
    REVOKE SELECT, UPDATE (actor_id, metadata) ON audit_log FROM athlya_cron;
    REVOKE DELETE ON export_jobs FROM athlya_cron;
    REVOKE DELETE ON outbox FROM athlya_cron;
    REVOKE SELECT, UPDATE ON users FROM athlya_cron;
    ALTER ROLE athlya_cron NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;
