-- =====================================================================
-- Athlya Platform — audit_log studio_id column (0015)
--
-- Issue #225.
--
-- Adds a `studio_id` column to `audit_log` to enable tenant-scoped reads
-- (Req 22.3 TODO resolved). Previously the RLS policy was a simple
-- `role = 'admin'` gate; this migration tightens it to:
--
--   `role = 'admin' AND (studio_id IS NULL OR studio_id = app_studio_id())`
--
-- Design choices:
--   - Column DEFAULT reads from the GUC that `withTenant` sets, so every
--     insert running inside a tenant transaction is automatically scoped
--     without any change to the application write path.
--   - Rows written outside a tenant context (JWT key rotation, DLQ replay,
--     billing webhooks via the HTTP driver) get studio_id = NULL and remain
--     visible to ALL admins — these are platform-level events.
--   - `studio_id` is stored WITHOUT a foreign key. A FK with ON DELETE SET NULL
--     would trigger the `audit_log_forbid_update` trigger (BEFORE UPDATE FOR
--     EACH ROW) and block studio deletions. Since audit rows must survive studio
--     deletion, denormalized UUID (no FK) is the correct choice — `studio_id`
--     records which studio context the event occurred in, not a live reference.
--   - Legacy rows (seeded before this migration) also get studio_id = NULL
--     and are therefore visible to all admins — backward-compatible.
-- =====================================================================

ALTER TABLE "audit_log"
    ADD COLUMN "studio_id" uuid
        DEFAULT (NULLIF(current_setting('app.studio_id', true), '')::uuid);

DROP POLICY IF EXISTS "audit_admin_only" ON "audit_log";
CREATE POLICY "audit_admin_only" ON "audit_log"
    FOR SELECT
    USING (
        public.app_role() = 'admin'
        AND (
            "studio_id" IS NULL
            OR "studio_id" = public.app_studio_id()
        )
    );
