-- Rollback for 0031_outbox_producer_drainer_policies.sql (issue #497).
DROP POLICY IF EXISTS "outbox_cron_update" ON "outbox";
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_cron') THEN
    REVOKE UPDATE ("published_at", "attempts") ON "outbox" FROM athlya_cron;
  END IF;
END
$$;
DROP POLICY IF EXISTS "outbox_insert_tenant" ON "outbox";
