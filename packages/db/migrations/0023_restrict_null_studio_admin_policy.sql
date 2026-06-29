-- Migration 0023 — Restrict NULL-studio rows from tenant admin RLS policies
--
-- Migrations 0014 (outbox) and 0015 (audit_log) added a studio_id column
-- and tightened admin-read policies to:
--   studio_id IS NULL OR studio_id = app_studio_id()
--
-- The IS NULL fallback was intended to keep platform-level events
-- (JWT rotation, billing webhooks, DLQ replay) visible until they
-- drain naturally. However, exposing platform operations to EVERY
-- tenant admin violates multi-tenant isolation: tenant admins of
-- studio A can read events belonging to studio B or to platform
-- operations that have no studio context.
--
-- Fix: drop the IS NULL clause from both policies. NULL-studio rows
-- are now readable only by BYPASSRLS roles (drain workers, platform
-- operators with psql access). Tenant admins see only their own
-- studio's rows — matching the isolation guarantee stated in the
-- platform design document.
--
-- Safe for canary: RLS policy changes take effect immediately with no
-- schema change. The restriction only affects SELECT; no inserts or
-- updates are affected. The drain worker uses BYPASSRLS and is
-- unaffected.

DROP POLICY IF EXISTS "outbox_admin_only" ON "outbox";--> statement-breakpoint
CREATE POLICY "outbox_admin_only" ON "outbox"
    FOR SELECT
    USING (
        public.app_role() = 'admin'
        AND "studio_id" = public.app_studio_id()
    );

DROP POLICY IF EXISTS "audit_admin_only" ON "audit_log";--> statement-breakpoint
CREATE POLICY "audit_admin_only" ON "audit_log"
    FOR SELECT
    USING (
        public.app_role() = 'admin'
        AND "studio_id" = public.app_studio_id()
    );
