DROP POLICY IF EXISTS "outbox_admin_only" ON "outbox";
CREATE POLICY "outbox_admin_only" ON "outbox"
    FOR SELECT
    USING (public.app_role() = 'admin');

ALTER TABLE "outbox" DROP COLUMN IF EXISTS "studio_id";
