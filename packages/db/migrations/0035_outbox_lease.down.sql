-- Rollback for 0035_outbox_lease.sql (issue #424).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_cron') THEN
        REVOKE UPDATE ("lease_until") ON "outbox" FROM athlya_cron;
    END IF;
END
$$;
ALTER TABLE "outbox" DROP COLUMN IF EXISTS "lease_until";
