-- =====================================================================
-- Athlya Platform — athlya_cron table grants (0009_audit_cron_grants)
--
-- Complements 0003_audit_anonymization.sql: the cron worker connects
-- as `athlya_cron` via CRON_DB_URL and runs direct SQL from
-- rgpd-purge.ts + anonymize-audit-tx.ts (not only SECURITY DEFINER).
--
-- Password for LOGIN is provisioned out-of-band (runbook Phase 8).
-- =====================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_cron') THEN
    ALTER ROLE athlya_cron LOGIN;
  END IF;
END
$$;
--> statement-breakpoint

GRANT SELECT, UPDATE ON users TO athlya_cron;
--> statement-breakpoint
GRANT DELETE ON outbox TO athlya_cron;
--> statement-breakpoint
GRANT DELETE ON export_jobs TO athlya_cron;
--> statement-breakpoint
GRANT SELECT, UPDATE (actor_id, metadata) ON audit_log TO athlya_cron;
