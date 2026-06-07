-- =====================================================================
-- Athlya Platform — revoke athlya_cron's direct audit_log grant (0012)
--
-- Issue #200. Migration 0009 granted athlya_cron
-- `SELECT, UPDATE (actor_id, metadata) ON audit_log`, but the cron RGPD
-- worker never touches audit_log directly: `worker.scheduled` calls the
-- SECURITY DEFINER function `anonymize_user_audit($1)` (worker.ts), which
-- runs as `athlya_owner` — the only role the `audit_log_immutable()`
-- trigger (migration 0003) lets through. The direct grant was therefore
-- dead privilege that:
--   * weakened least-privilege (athlya_cron could SELECT audit PII), and
--   * broke the immutability invariant the pgTAP suite asserts
--     (`athlya_cron UPDATE audit_log` must fail with 42501, not pass the
--     privilege check only to be stopped later by the trigger as P0001).
--
-- Revoking it restores the documented model: athlya_cron has NO direct
-- grant on audit_log and reaches it solely through the sanctioned
-- SECURITY DEFINER function (EXECUTE granted in 0003, left intact).
--
-- The other 0009 grants (users, outbox, export_jobs) are legitimate and
-- kept. `anonymizeAuditLogViaSql` (a direct-UPDATE alternative) stays
-- unwired — it would be blocked by the trigger; see its source note.
-- =====================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_cron') THEN
    REVOKE SELECT, UPDATE (actor_id, metadata) ON audit_log FROM athlya_cron;
  END IF;
END
$$;
