-- =====================================================================
-- Athlya Platform — add studio_id to outbox for tenant-scoped RLS (0014)
--
-- Issue #234. The outbox_admin_only RLS policy allows any admin from
-- any studio to SELECT all pending events across all studios. Adding a
-- denormalised studio_id column and tightening the policy to
--   studio_id = app_studio_id()
-- ensures each admin sees only their own studio's pending events.
--
-- Column strategy: nullable (existing rows have no studio context) with
-- a column DEFAULT of current_setting('app.studio_id', true)::uuid so
-- rows inserted inside a withTenant transaction (which issues
-- SET LOCAL app.studio_id = ...) are automatically stamped. Rows
-- inserted without tenant context (e.g. tests, backfills) remain NULL
-- and the updated policy grants access where studio_id IS NULL to avoid
-- hiding legacy rows from admins.
--
-- The drain worker (athlya_cron / BYPASSRLS) is unaffected — it skips
-- RLS entirely when claiming and publishing rows.
-- =====================================================================

ALTER TABLE "outbox"
    ADD COLUMN "studio_id" uuid
        REFERENCES "studios" ("id") ON DELETE SET NULL
        DEFAULT (current_setting('app.studio_id', true)::uuid);

-- Tighten the admin read policy to the caller's studio.
DROP POLICY IF EXISTS "outbox_admin_only" ON "outbox";
CREATE POLICY "outbox_admin_only" ON "outbox"
    FOR SELECT
    USING (
        public.app_role() = 'admin'
        AND (
            "studio_id" IS NULL
            OR "studio_id" = public.app_studio_id()
        )
    );
