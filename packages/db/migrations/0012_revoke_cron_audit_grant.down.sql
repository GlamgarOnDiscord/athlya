-- Reverse of 0012 — restore the (dead) 0009 audit_log grant on athlya_cron.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_cron') THEN
    GRANT SELECT, UPDATE (actor_id, metadata) ON audit_log TO athlya_cron;
  END IF;
END
$$;
