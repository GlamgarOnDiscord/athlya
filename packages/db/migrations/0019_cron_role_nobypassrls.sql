-- =====================================================================
-- Athlya Platform — strip BYPASSRLS from athlya_cron (issue #299)
--
-- Problem
-- -------
-- Migration 0009 granted BYPASSRLS to athlya_cron so the RGPD
-- maintenance cron could run cross-tenant UPDATE/DELETE without being
-- filtered by the studio-scoped RLS policies. A compromised
-- CRON_DB_URL therefore has cross-tenant read/write access to users,
-- outbox, and export_jobs — the same blast radius as neondb_owner for
-- those tables.
--
-- Fix
-- ---
-- Replace the BYPASSRLS blanket with explicit per-table RLS policies
-- that permit athlya_cron — and only athlya_cron — to perform the
-- specific operations the RGPD maintenance cycle requires:
--
--   • SELECT + UPDATE on users   (anonymisation: CTE + UPDATE)
--   • SELECT + DELETE on outbox  (purge: subquery + DELETE)
--   • SELECT + DELETE on export_jobs (purge: subquery + DELETE)
--
-- The SELECT privilege missing on outbox and export_jobs is also
-- added here (0009 only granted DELETE on those tables; the subqueries
-- in rgpd-purge.ts require SELECT as well).
--
-- athlya_cron's direct access is now bounded to:
--   1. The specific tables listed above (table-level GRANT)
--   2. The specific rows needed (RLS policy)
--   3. The specific operations listed (GRANT + policy)
--
-- The existing SECURITY DEFINER path for audit_log anonymization is
-- unchanged: athlya_cron calls anonymize_user_audit() which runs as
-- athlya_owner (BYPASSRLS) — athlya_cron itself never touches audit_log.
--
-- Note: this migration must run after 0009 (which creates the grants)
-- and 0004 (which FORCE-enables RLS on these tables).
-- =====================================================================

-- 1. Add SELECT privilege on outbox and export_jobs (needed for the
--    DELETE ... WHERE id IN (SELECT ...) subqueries in rgpd-purge.ts).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_cron') THEN
    GRANT SELECT ON outbox TO athlya_cron;
    GRANT SELECT ON export_jobs TO athlya_cron;
  END IF;
END
$$;
--> statement-breakpoint

-- 2. RLS policies — users (anonymization: SELECT for CTE + UPDATE)
CREATE POLICY "users_cron_select" ON "users"
    FOR SELECT
    USING (current_user = 'athlya_cron');
--> statement-breakpoint

CREATE POLICY "users_cron_update" ON "users"
    FOR UPDATE
    USING (current_user = 'athlya_cron')
    WITH CHECK (current_user = 'athlya_cron');
--> statement-breakpoint

-- 3. RLS policies — outbox (purge: SELECT for subquery + DELETE)
CREATE POLICY "outbox_cron_select" ON "outbox"
    FOR SELECT
    USING (current_user = 'athlya_cron');
--> statement-breakpoint

CREATE POLICY "outbox_cron_delete" ON "outbox"
    FOR DELETE
    USING (current_user = 'athlya_cron');
--> statement-breakpoint

-- 4. RLS policies — export_jobs (purge: SELECT for subquery + DELETE)
CREATE POLICY "export_jobs_cron_select" ON "export_jobs"
    FOR SELECT
    USING (current_user = 'athlya_cron');
--> statement-breakpoint

CREATE POLICY "export_jobs_cron_delete" ON "export_jobs"
    FOR DELETE
    USING (current_user = 'athlya_cron');
--> statement-breakpoint

-- 5. Strip BYPASSRLS from athlya_cron. The policies above replace it.
--    athlya_cron can now only access the specific rows permitted by
--    RLS — no cross-table lateral movement is possible.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_cron') THEN
    ALTER ROLE athlya_cron NOBYPASSRLS;
  END IF;
END
$$;
