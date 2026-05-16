-- =====================================================================
-- Rollback for 0001_rls.sql
--
-- Reverses every object created by the RLS migration, in reverse
-- order of creation:
--
--   1. Drop each policy (per-table, reverse of forward order so the
--      rollback mirrors the forward listing line-for-line — useful
--      during code review).
--   2. `NO FORCE ROW LEVEL SECURITY` then `DISABLE ROW LEVEL SECURITY`
--      on each tenant-scoped table.
--   3. Drop the `app_user_id()`, `app_studio_id()`, `app_role()` SQL
--      helper functions. No policy references them any more after
--      step 1, so the drops succeed without CASCADE.
--
-- Idempotent: every `DROP POLICY` / `DROP FUNCTION` uses `IF EXISTS`,
-- and `ALTER TABLE ... DISABLE` is a no-op on a table whose RLS is
-- already disabled.
--
-- Order of tables mirrors sections 11 -> 3 of 0001_rls.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Drop policies (reverse order of forward migration)
-- ---------------------------------------------------------------------

-- § 11. push_tokens
DROP POLICY IF EXISTS "push_tokens_delete_own"     ON "push_tokens";
DROP POLICY IF EXISTS "push_tokens_insert_own"     ON "push_tokens";
DROP POLICY IF EXISTS "push_tokens_read_own"       ON "push_tokens";

-- § 10. idempotency_keys
DROP POLICY IF EXISTS "idempotency_keys_delete_own" ON "idempotency_keys";
DROP POLICY IF EXISTS "idempotency_keys_insert_own" ON "idempotency_keys";
DROP POLICY IF EXISTS "idempotency_keys_read_own"   ON "idempotency_keys";

-- § 9. outbox
DROP POLICY IF EXISTS "outbox_admin_only"          ON "outbox";

-- § 8. audit_log
DROP POLICY IF EXISTS "audit_no_delete"            ON "audit_log";
DROP POLICY IF EXISTS "audit_no_update"            ON "audit_log";
DROP POLICY IF EXISTS "audit_no_insert"            ON "audit_log";
DROP POLICY IF EXISTS "audit_admin_only"           ON "audit_log";

-- § 7. workout_sessions
DROP POLICY IF EXISTS "workout_sessions_delete_own" ON "workout_sessions";
DROP POLICY IF EXISTS "workout_sessions_update_own" ON "workout_sessions";
DROP POLICY IF EXISTS "workout_sessions_insert_own" ON "workout_sessions";
DROP POLICY IF EXISTS "workout_sessions_read_own"   ON "workout_sessions";

-- § 6. reservations
DROP POLICY IF EXISTS "reservations_update_admin"           ON "reservations";
DROP POLICY IF EXISTS "reservations_update_own"             ON "reservations";
DROP POLICY IF EXISTS "reservations_insert_own"             ON "reservations";
DROP POLICY IF EXISTS "reservations_read_admin_same_studio" ON "reservations";
DROP POLICY IF EXISTS "reservations_read_own"               ON "reservations";

-- § 5. classes
DROP POLICY IF EXISTS "classes_delete_admin"       ON "classes";
DROP POLICY IF EXISTS "classes_update_admin"       ON "classes";
DROP POLICY IF EXISTS "classes_insert_admin"       ON "classes";
DROP POLICY IF EXISTS "classes_read_same_studio"   ON "classes";

-- § 4. users
DROP POLICY IF EXISTS "users_update_admin"         ON "users";
DROP POLICY IF EXISTS "users_update_own"           ON "users";
DROP POLICY IF EXISTS "users_read_same_studio"     ON "users";
DROP POLICY IF EXISTS "users_read_own"             ON "users";

-- § 3. studios
DROP POLICY IF EXISTS "studios_read_own_tenant"    ON "studios";

-- ---------------------------------------------------------------------
-- 2. Disable RLS on every tenant-scoped table
--
-- `NO FORCE` must come before `DISABLE`: FORCE is a modifier on top of
-- the enabled state. The reverse pair cleanly restores the
-- pre-0001_rls state.
-- ---------------------------------------------------------------------

ALTER TABLE "push_tokens"      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "push_tokens"      DISABLE  ROW LEVEL SECURITY;
ALTER TABLE "idempotency_keys" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_keys" DISABLE  ROW LEVEL SECURITY;
ALTER TABLE "outbox"           NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "outbox"           DISABLE  ROW LEVEL SECURITY;
ALTER TABLE "audit_log"        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_log"        DISABLE  ROW LEVEL SECURITY;
ALTER TABLE "workout_sessions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "workout_sessions" DISABLE  ROW LEVEL SECURITY;
ALTER TABLE "reservations"     NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "reservations"     DISABLE  ROW LEVEL SECURITY;
ALTER TABLE "classes"          NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "classes"          DISABLE  ROW LEVEL SECURITY;
ALTER TABLE "users"            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "users"            DISABLE  ROW LEVEL SECURITY;
ALTER TABLE "studios"          NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "studios"          DISABLE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 3. Drop the session-variable accessor helpers
--
-- No policy now references them, so no CASCADE is needed.
-- ---------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.app_role();
DROP FUNCTION IF EXISTS public.app_studio_id();
DROP FUNCTION IF EXISTS public.app_user_id();
