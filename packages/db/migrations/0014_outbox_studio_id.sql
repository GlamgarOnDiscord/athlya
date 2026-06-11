-- =====================================================================
-- Athlya Platform — add studio_id to outbox for tenant-scoped RLS (0014)
--
-- Issue #234. The outbox_admin_only RLS policy allows any admin from
-- any studio to SELECT all pending events across all studios. Adding a
-- denormalised studio_id column and tightening the policy to
--   studio_id = app_studio_id()
-- ensures each admin sees only their own studio's pending events.
--
-- Column strategy: nullable (legacy rows from before this migration have
-- no studio context; the IS NULL fallback in the policy keeps them visible
-- to all admins until they drain naturally) with a column DEFAULT of
-- NULLIF(current_setting('app.studio_id',true),'')::uuid so rows inserted
-- inside a withTenant transaction are automatically stamped.
-- test_unset_tenant() sets the GUC to '' not NULL; the NULLIF guard ensures
-- that path yields NULL rather than a cast error.
--
-- ON DELETE CASCADE rather than SET NULL: when a studio is deleted its
-- outbox rows are deleted too. ON DELETE SET NULL would set studio_id back
-- to NULL, re-enabling the IS NULL policy fallback for the former studio's
-- rows and reintroducing cross-tenant visibility for any admin.
-- =====================================================================

ALTER TABLE "outbox"
    ADD COLUMN "studio_id" uuid
        REFERENCES "studios" ("id") ON DELETE CASCADE
        DEFAULT (NULLIF(current_setting('app.studio_id', true), '')::uuid);

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
