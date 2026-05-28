-- =====================================================================
-- Athlya Platform — audit_log INSERT policy for athlya_app (0011)
--
-- Slice B2-bis / issue #118 — replaces `audit_no_insert WITH CHECK (false)`
-- so `athlya_app` can append audit rows inside tenant transactions after
-- the production `DB_URL` cutover (see docs/runbooks/db-role-switch.md).
--
-- Immutability remains enforced by:
--   * no UPDATE / DELETE grants on audit_log for athlya_app
--   * audit_no_update / audit_no_delete RLS policies (USING false)
--   * audit_log_immutable() trigger on UPDATE / DELETE
-- =====================================================================

DROP POLICY IF EXISTS "audit_no_insert" ON "audit_log";--> statement-breakpoint

CREATE POLICY "audit_app_insert" ON "audit_log"
    FOR INSERT
    WITH CHECK (true);
