-- Rollback 0011_audit_log_app_insert.sql — restore deny-all INSERT policy.

DROP POLICY IF EXISTS "audit_app_insert" ON "audit_log";--> statement-breakpoint

CREATE POLICY "audit_no_insert" ON "audit_log"
    FOR INSERT
    WITH CHECK (false);
