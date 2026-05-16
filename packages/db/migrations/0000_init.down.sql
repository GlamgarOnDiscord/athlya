-- =====================================================================
-- Rollback for 0000_init.sql
--
-- Reverses every object created by the forward init migration, in
-- FK-safe / dependency-safe reverse order:
--
--   1. Drop the audit_log immutability triggers, then the function
--      they share. (Triggers reference the function; drop them first.)
--   2. Drop tables in reverse foreign-key order — child tables first,
--      parent tables last — using `CASCADE` so any leftover indexes,
--      constraints, or dependent objects created by later migrations
--      or by application-level hot-fixes are cleaned up too.
--   3. Drop the enum types the tables referenced. Must happen after
--      the tables go (enum column types pin the type).
--
-- Deliberately NOT dropped:
--   * Extensions `pgcrypto` and `citext`. PostgreSQL extensions live
--     at the cluster level and may be in use by other databases on
--     the same Neon project / local cluster. Dropping them here would
--     leak blast-radius beyond the Athlya database. Re-applying
--     `0000_init.sql` is idempotent on extensions (`IF NOT EXISTS`),
--     so leaving them in place is both safe and reversible.
--
-- Idempotency: every statement uses `IF EXISTS` so running this
-- script twice is a no-op on the second pass.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Audit_log immutability triggers + function
--
-- Names match the forward migration: `audit_log_forbid_update` and
-- `audit_log_forbid_delete` — not `audit_log_immutable_*`. Both share
-- the `audit_log_immutable()` trigger function; we drop the triggers
-- first so the function has no dependents when we drop it.
-- ---------------------------------------------------------------------

DROP TRIGGER IF EXISTS audit_log_forbid_update ON "audit_log";
DROP TRIGGER IF EXISTS audit_log_forbid_delete ON "audit_log";
DROP FUNCTION IF EXISTS audit_log_immutable();

-- ---------------------------------------------------------------------
-- 2. Tables (reverse FK order, CASCADE to catch dependent objects)
--
-- FK graph from 0000_init.sql:
--
--       studios <-- users <-- classes <-- reservations
--                      ^         ^
--                      |         |
--                      +-- workout_sessions
--                      |
--                      +-- audit_log
--                      |
--                      +-- idempotency_keys
--                      |
--                      +-- push_tokens
--
--       outbox (standalone, no FK)
--
-- We drop leaf tables first (push_tokens, idempotency_keys, outbox,
-- audit_log, workout_sessions, reservations), then intermediate
-- (classes), then users, then studios. `CASCADE` handles any
-- downstream migration that added an FK we don't know about.
-- ---------------------------------------------------------------------

DROP TABLE IF EXISTS "push_tokens"       CASCADE;
DROP TABLE IF EXISTS "idempotency_keys"  CASCADE;
DROP TABLE IF EXISTS "outbox"            CASCADE;
DROP TABLE IF EXISTS "audit_log"         CASCADE;
DROP TABLE IF EXISTS "workout_sessions"  CASCADE;
DROP TABLE IF EXISTS "reservations"      CASCADE;
DROP TABLE IF EXISTS "classes"           CASCADE;
DROP TABLE IF EXISTS "users"             CASCADE;
DROP TABLE IF EXISTS "studios"           CASCADE;

-- ---------------------------------------------------------------------
-- 3. Enum types
--
-- Drop after the tables that used them, otherwise PostgreSQL refuses
-- the DROP TYPE with "cannot drop type ... because other objects
-- depend on it".
-- ---------------------------------------------------------------------

DROP TYPE IF EXISTS "public"."push_platform";
DROP TYPE IF EXISTS "public"."reservation_status";
DROP TYPE IF EXISTS "public"."user_role";

-- ---------------------------------------------------------------------
-- 4. Extensions — intentionally preserved
--
-- `pgcrypto` and `citext` are cluster-shared. Do NOT drop them here:
--   DROP EXTENSION IF EXISTS "citext";   -- DELIBERATELY OMITTED
--   DROP EXTENSION IF EXISTS "pgcrypto"; -- DELIBERATELY OMITTED
-- ---------------------------------------------------------------------
