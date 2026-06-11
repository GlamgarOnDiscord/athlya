-- =====================================================================
-- Athlya Platform — Row-Level Security policies migration (0001_rls)
--
-- Task 2.3 / Requirements 13.1–13.6, 22.3.
--
-- This migration is hand-authored: drizzle-kit does not emit RLS
-- policies automatically. It:
--
--   1. Enables Row-Level Security on every tenant-scoped table and
--      FORCES it so the table owner is subject to the policies as well
--      (Req 13.6).
--   2. Installs policies keyed on the three session variables the
--      tenant middleware (`withTenant`) injects at transaction start:
--        - `app.user_id`   : uuid of the authenticated user
--        - `app.studio_id` : uuid of the user's studio
--        - `app.role`      : one of 'member' | 'coach' | 'admin'
--      All policies read them with the `(..., true)` "missing_ok" form
--      so an unscoped connection (CI diagnostics, drizzle-kit push) does
--      not raise `unrecognized configuration parameter`. A NULL
--      `current_setting` coerced with `::uuid` would raise; we funnel
--      reads through SQL helpers that return NULL when the GUC is unset
--      and compare with `IS NOT DISTINCT FROM`-safe equality so an
--      unscoped session matches no rows (fail-closed).
--   3. Explicitly denies `UPDATE` and `DELETE` on `audit_log` for every
--      role — complements the `audit_log_immutable()` trigger installed
--      in `0000_init.sql` (Req 22.2).
--   4. Uses `DROP POLICY IF EXISTS` + `CREATE POLICY` throughout so the
--      migration is safely re-runnable.
--
-- Design reference: `.kiro/specs/athlya-platform/design.md`, section
-- "Row Level Security (RLS)".
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Session-variable accessor helpers
--
-- Reading `current_setting('app.user_id')::uuid` directly fails when
-- the GUC is unset (the cast applied to NULL raises). Wrapping the read
-- in a STABLE SQL function that uses the `missing_ok = true` form lets
-- us express policies as "equality with a possibly-NULL scope" and
-- inherits PostgreSQL's standard NULL semantics: when the scope is
-- NULL (unscoped connection) no row matches, which is the fail-closed
-- default Req 13.6 demands.
--
-- The helpers are marked STABLE (safe to call multiple times per row
-- within one statement) and live in the `public` schema alongside the
-- tables they guard. They return NULL instead of raising when the GUC
-- is missing or empty.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.app_studio_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.studio_id', true), '')::uuid
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.app_role() RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.role', true), '')
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 2. Enable RLS on every tenant-scoped table
--
-- `FORCE ROW LEVEL SECURITY` applies the policies even to the table
-- owner (the migration/superuser role used by drizzle-kit). Without
-- FORCE, a connection using the owner role would bypass policies,
-- which would hide bugs until the first non-owner query in production.
-- The worker role used by the outbox drainer runs with `BYPASSRLS` and
-- will be set up explicitly by the deployment pipeline (documented in
-- migrations/README.md).
-- ---------------------------------------------------------------------

ALTER TABLE "studios"          ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "studios"          FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users"            ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users"            FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "classes"          ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "classes"          FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reservations"     ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reservations"     FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workout_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workout_sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log"        ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log"        FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbox"           ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbox"           FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "push_tokens"      ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "push_tokens"      FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 3. studios — tenant sees only its own studio row
--
-- Every authenticated request carries `app.studio_id`. The only
-- mutation of `studios` happens in platform-admin back-office flows
-- that run under a BYPASSRLS role, so we only need the read policy.
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "studios_read_own_tenant" ON "studios";--> statement-breakpoint
CREATE POLICY "studios_read_own_tenant" ON "studios"
    FOR SELECT
    USING (id = public.app_studio_id());
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 4. users — self-read, admin/coach see same-studio members,
--           self-update, admin updates same-studio members
--
-- Req 13.2: SELECT restricted to own row OR (role ∈ {admin, coach} AND
-- same studio).
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "users_read_own" ON "users";--> statement-breakpoint
CREATE POLICY "users_read_own" ON "users"
    FOR SELECT
    USING (id = public.app_user_id());
--> statement-breakpoint

DROP POLICY IF EXISTS "users_read_same_studio" ON "users";--> statement-breakpoint
CREATE POLICY "users_read_same_studio" ON "users"
    FOR SELECT
    USING (
        studio_id = public.app_studio_id()
        AND public.app_role() IN ('admin', 'coach')
    );
--> statement-breakpoint

DROP POLICY IF EXISTS "users_update_own" ON "users";--> statement-breakpoint
CREATE POLICY "users_update_own" ON "users"
    FOR UPDATE
    USING (id = public.app_user_id())
    WITH CHECK (id = public.app_user_id());
--> statement-breakpoint

DROP POLICY IF EXISTS "users_update_admin" ON "users";--> statement-breakpoint
CREATE POLICY "users_update_admin" ON "users"
    FOR UPDATE
    USING (
        studio_id = public.app_studio_id()
        AND public.app_role() = 'admin'
    )
    WITH CHECK (
        studio_id = public.app_studio_id()
        AND public.app_role() = 'admin'
    );
--> statement-breakpoint

-- INSERT / DELETE on users happen through the Auth service under a
-- BYPASSRLS role (register, RGPD deletion cascade). No FOR INSERT /
-- FOR DELETE policy is created here so application roles cannot forge
-- users or hard-delete them; soft-delete via `deleted_at` goes through
-- `users_update_admin` or the service role.

-- ---------------------------------------------------------------------
-- 5. classes — same-studio read for everyone, writes restricted to
--              admins of that studio
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "classes_read_same_studio" ON "classes";--> statement-breakpoint
CREATE POLICY "classes_read_same_studio" ON "classes"
    FOR SELECT
    USING (studio_id = public.app_studio_id());
--> statement-breakpoint

DROP POLICY IF EXISTS "classes_insert_admin" ON "classes";--> statement-breakpoint
CREATE POLICY "classes_insert_admin" ON "classes"
    FOR INSERT
    WITH CHECK (
        studio_id = public.app_studio_id()
        AND public.app_role() = 'admin'
    );
--> statement-breakpoint

DROP POLICY IF EXISTS "classes_update_admin" ON "classes";--> statement-breakpoint
CREATE POLICY "classes_update_admin" ON "classes"
    FOR UPDATE
    USING (
        studio_id = public.app_studio_id()
        AND public.app_role() = 'admin'
    )
    WITH CHECK (
        studio_id = public.app_studio_id()
        AND public.app_role() = 'admin'
    );
--> statement-breakpoint

DROP POLICY IF EXISTS "classes_delete_admin" ON "classes";--> statement-breakpoint
CREATE POLICY "classes_delete_admin" ON "classes"
    FOR DELETE
    USING (
        studio_id = public.app_studio_id()
        AND public.app_role() = 'admin'
    );
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 6. reservations — owner-scoped for members, studio-scoped (via join
--                   to classes) for admin/coach
--
-- Req 13.3: SELECT restricted to rows where `user_id = app.user_id`.
-- Admins of a studio can additionally see reservations attached to the
-- studio's classes — implemented by joining `classes.studio_id`.
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "reservations_read_own" ON "reservations";--> statement-breakpoint
CREATE POLICY "reservations_read_own" ON "reservations"
    FOR SELECT
    USING (user_id = public.app_user_id());
--> statement-breakpoint

DROP POLICY IF EXISTS "reservations_read_admin_same_studio" ON "reservations";--> statement-breakpoint
CREATE POLICY "reservations_read_admin_same_studio" ON "reservations"
    FOR SELECT
    USING (
        public.app_role() IN ('admin', 'coach')
        AND EXISTS (
            SELECT 1
            FROM "classes" c
            WHERE c.id = "reservations".class_id
              AND c.studio_id = public.app_studio_id()
        )
    );
--> statement-breakpoint

DROP POLICY IF EXISTS "reservations_insert_own" ON "reservations";--> statement-breakpoint
CREATE POLICY "reservations_insert_own" ON "reservations"
    FOR INSERT
    WITH CHECK (user_id = public.app_user_id());
--> statement-breakpoint

DROP POLICY IF EXISTS "reservations_update_own" ON "reservations";--> statement-breakpoint
CREATE POLICY "reservations_update_own" ON "reservations"
    FOR UPDATE
    USING (user_id = public.app_user_id())
    WITH CHECK (user_id = public.app_user_id());
--> statement-breakpoint

DROP POLICY IF EXISTS "reservations_update_admin" ON "reservations";--> statement-breakpoint
CREATE POLICY "reservations_update_admin" ON "reservations"
    FOR UPDATE
    USING (
        public.app_role() = 'admin'
        AND EXISTS (
            SELECT 1
            FROM "classes" c
            WHERE c.id = "reservations".class_id
              AND c.studio_id = public.app_studio_id()
        )
    )
    WITH CHECK (
        public.app_role() = 'admin'
        AND EXISTS (
            SELECT 1
            FROM "classes" c
            WHERE c.id = "reservations".class_id
              AND c.studio_id = public.app_studio_id()
        )
    );
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 7. workout_sessions — strictly owner-scoped
--
-- Workout sessions are personal: neither admins nor coaches see them
-- through RLS. Admin analytics jobs run under a BYPASSRLS service role.
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "workout_sessions_read_own" ON "workout_sessions";--> statement-breakpoint
CREATE POLICY "workout_sessions_read_own" ON "workout_sessions"
    FOR SELECT
    USING (user_id = public.app_user_id());
--> statement-breakpoint

DROP POLICY IF EXISTS "workout_sessions_insert_own" ON "workout_sessions";--> statement-breakpoint
CREATE POLICY "workout_sessions_insert_own" ON "workout_sessions"
    FOR INSERT
    WITH CHECK (user_id = public.app_user_id());
--> statement-breakpoint

DROP POLICY IF EXISTS "workout_sessions_update_own" ON "workout_sessions";--> statement-breakpoint
CREATE POLICY "workout_sessions_update_own" ON "workout_sessions"
    FOR UPDATE
    USING (user_id = public.app_user_id())
    WITH CHECK (user_id = public.app_user_id());
--> statement-breakpoint

DROP POLICY IF EXISTS "workout_sessions_delete_own" ON "workout_sessions";--> statement-breakpoint
CREATE POLICY "workout_sessions_delete_own" ON "workout_sessions"
    FOR DELETE
    USING (user_id = public.app_user_id());
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 8. audit_log — admin-only read, no UPDATE / DELETE for anyone
--
-- Req 13.4 + 22.3: `audit_log` is readable only by admins.
-- Req 22.2: `audit_log` must be completely immutable. The
-- `audit_log_immutable()` trigger installed in 0000_init.sql already
-- raises on UPDATE / DELETE; the explicit USING (false) policies below
-- add a second line of defence at the RLS layer so application roles
-- cannot even reach the trigger.
--
-- Studio-scoping note (Req 22.3): the audit_log row has no direct
-- `studio_id` column — `actor_id` is nullable after anonymization. The
-- strict scoping "admin of the same studio as the actor" is enforced in
-- the API layer (audit query helper joins on `users.studio_id`); the
-- RLS layer keeps the simpler `role = 'admin'` gate so non-admins
-- cannot read any row at all. See README.md § "audit_log scoping".
-- Migration 0015 adds the `studio_id` column and replaces this policy
-- with `role = 'admin' AND (studio_id IS NULL OR studio_id = app_studio_id())`
-- to fully close Req 22.3. The policy below is superseded by 0015.
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "audit_admin_only" ON "audit_log";--> statement-breakpoint
CREATE POLICY "audit_admin_only" ON "audit_log"
    FOR SELECT
    USING (public.app_role() = 'admin');
--> statement-breakpoint

DROP POLICY IF EXISTS "audit_no_insert" ON "audit_log";--> statement-breakpoint
-- Audit rows are written by the API under a BYPASSRLS service role so
-- that `appendAudit` succeeds inside any tenant transaction. Deny any
-- INSERT from the regular application role: forgery protection.
CREATE POLICY "audit_no_insert" ON "audit_log"
    FOR INSERT
    WITH CHECK (false);
--> statement-breakpoint

DROP POLICY IF EXISTS "audit_no_update" ON "audit_log";--> statement-breakpoint
CREATE POLICY "audit_no_update" ON "audit_log"
    FOR UPDATE
    USING (false)
    WITH CHECK (false);
--> statement-breakpoint

DROP POLICY IF EXISTS "audit_no_delete" ON "audit_log";--> statement-breakpoint
CREATE POLICY "audit_no_delete" ON "audit_log"
    FOR DELETE
    USING (false);
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 9. outbox — admin-only visibility
--
-- The outbox drain worker runs under a BYPASSRLS service role so it can
-- claim rows regardless of tenant. For observability admins of a
-- studio can read pending events; no application role has INSERT /
-- UPDATE / DELETE access.
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "outbox_admin_only" ON "outbox";--> statement-breakpoint
CREATE POLICY "outbox_admin_only" ON "outbox"
    FOR SELECT
    USING (public.app_role() = 'admin');
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 10. idempotency_keys — strictly owner-scoped
--
-- Each row is bound to `(key, user_id)`; clients may only see and
-- replay their own. The idempotency middleware reads/writes under the
-- caller's tenant, so these policies are enforced at every hop.
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "idempotency_keys_read_own" ON "idempotency_keys";--> statement-breakpoint
CREATE POLICY "idempotency_keys_read_own" ON "idempotency_keys"
    FOR SELECT
    USING (user_id = public.app_user_id());
--> statement-breakpoint

DROP POLICY IF EXISTS "idempotency_keys_insert_own" ON "idempotency_keys";--> statement-breakpoint
CREATE POLICY "idempotency_keys_insert_own" ON "idempotency_keys"
    FOR INSERT
    WITH CHECK (user_id = public.app_user_id());
--> statement-breakpoint

DROP POLICY IF EXISTS "idempotency_keys_delete_own" ON "idempotency_keys";--> statement-breakpoint
CREATE POLICY "idempotency_keys_delete_own" ON "idempotency_keys"
    FOR DELETE
    USING (user_id = public.app_user_id());
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 11. push_tokens — strictly owner-scoped
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "push_tokens_read_own" ON "push_tokens";--> statement-breakpoint
CREATE POLICY "push_tokens_read_own" ON "push_tokens"
    FOR SELECT
    USING (user_id = public.app_user_id());
--> statement-breakpoint

DROP POLICY IF EXISTS "push_tokens_insert_own" ON "push_tokens";--> statement-breakpoint
CREATE POLICY "push_tokens_insert_own" ON "push_tokens"
    FOR INSERT
    WITH CHECK (user_id = public.app_user_id());
--> statement-breakpoint

DROP POLICY IF EXISTS "push_tokens_delete_own" ON "push_tokens";--> statement-breakpoint
CREATE POLICY "push_tokens_delete_own" ON "push_tokens"
    FOR DELETE
    USING (user_id = public.app_user_id());
