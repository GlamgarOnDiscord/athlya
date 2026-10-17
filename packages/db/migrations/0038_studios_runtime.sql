-- =====================================================================
-- 0038 — studios under the athlya_app runtime role (issues #224, #117)
--
-- `studios` is FORCE RLS and its only policy is `studios_read_own_tenant`
-- (`id = app_studio_id()`, migration 0001). Under `athlya_app`
-- (NOBYPASSRLS) two paths were broken:
--
--   1. The tenant claim guard resolves `x-studio-slug` to an id BEFORE
--      any tenant context exists. A raw `SELECT id FROM studios` matched
--      zero rows, so every request carrying the header got a 404
--      `tenant_mismatch`. It now calls `studio_id_by_slug(text)`, a
--      narrow SECURITY DEFINER function that returns the id only.
--   2. `GET /v1/studios/me` and `PATCH /v1/studios/me` ran without the
--      tenant GUCs. They now run through `withTenantHttp`, so the read
--      policy applies. `athlya_app` only had SELECT on `studios`
--      (migration 0004) and no policy allowed an UPDATE, so studio
--      admins could not edit their branding: this migration grants
--      UPDATE on the two editable columns only and adds an UPDATE
--      policy restricted to an admin of that studio.
--
-- Conventions (same as 0032): owner `athlya_owner`, pinned
-- `search_path`, EXECUTE revoked from PUBLIC and granted to
-- `athlya_app` only. `athlya_owner` already holds SELECT on `studios`
-- (migration 0032).
--
-- Additive only (one function, one column-scoped grant, one policy):
-- safe for canary rollout, old Workers keep their raw queries.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Pre-authentication slug resolution
--
-- Returns the id of the live studio with that slug, or NULL. Nothing
-- else leaves the function: no name, no branding, no tombstoned rows.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION studio_id_by_slug(p_slug text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT s.id FROM studios s WHERE s.slug = p_slug AND s.deleted_at IS NULL LIMIT 1
$$;
--> statement-breakpoint

ALTER FUNCTION studio_id_by_slug(text) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION studio_id_by_slug(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION studio_id_by_slug(text) TO athlya_app;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 2. Studio admins edit their own studio's branding
--
-- Column-scoped grant: `slug`, `id`, `created_at` and `deleted_at` stay
-- immutable for the application. The policy only lets an admin of the
-- studio update its row, and WITH CHECK keeps the row in that studio.
-- ---------------------------------------------------------------------

GRANT UPDATE ("name", "brand_color") ON "studios" TO athlya_app;--> statement-breakpoint

DROP POLICY IF EXISTS "studios_admin_update_own" ON "studios";--> statement-breakpoint
CREATE POLICY "studios_admin_update_own" ON "studios"
    FOR UPDATE
    USING (id = public.app_studio_id() AND public.app_role() = 'admin' AND deleted_at IS NULL)
    WITH CHECK (id = public.app_studio_id() AND public.app_role() = 'admin');
