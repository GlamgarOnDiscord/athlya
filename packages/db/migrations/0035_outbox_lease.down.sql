-- Rollback for 0035_outbox_lease.sql (issue #424). Idempotent: dropping
-- the column also drops its column-level grant to athlya_cron.
DROP TRIGGER IF EXISTS outbox_skip_leased_claim ON "outbox";
DROP FUNCTION IF EXISTS public.outbox_skip_leased_claim();
ALTER TABLE "outbox" DROP COLUMN IF EXISTS "lease_until";
