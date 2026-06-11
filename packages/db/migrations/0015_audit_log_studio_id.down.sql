DROP POLICY IF EXISTS "audit_admin_only" ON "audit_log";
CREATE POLICY "audit_admin_only" ON "audit_log"
    FOR SELECT
    USING (public.app_role() = 'admin');
ALTER TABLE "audit_log" DROP COLUMN IF EXISTS "studio_id";
