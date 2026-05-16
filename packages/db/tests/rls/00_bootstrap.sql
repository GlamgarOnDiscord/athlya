-- =====================================================================
-- Athlya Platform — pgTAP bootstrap for RLS tests (task 2.6)
--
-- This script is sourced by every per-table test file via `\i`. It must
-- run once per psql invocation and leave the database in a known state
-- before the first `BEGIN;` / `SELECT plan(...)` block.
--
-- What it does:
--   1. Ensures the `pgtap` extension is available. In CI the Postgres
--      image ships with pgTAP; locally the `pgtap/pgtap` Docker image
--      works out of the box. We use `CREATE EXTENSION IF NOT EXISTS`
--      wrapped in a DO block so that permission errors (e.g. running
--      without SUPERUSER) do not abort the whole suite — they surface
--      later when the first `plan(...)` call fails, which is a cleaner
--      error for the CI log.
--   2. Creates a dedicated non-superuser role `athlya_tenant_test`.
--      This is CRITICAL: the Postgres test container (pgtap/pgtap and
--      the official postgres image both) connects as the `postgres`
--      superuser, and **superusers always bypass Row-Level Security**
--      regardless of `FORCE ROW LEVEL SECURITY`. Running the
--      assertions from the superuser session would give false
--      positives. Each test file issues `SET LOCAL ROLE
--      athlya_tenant_test` inside its transaction (via the
--      `test_set_tenant` helper) so the policies actually apply.
--   3. TRUNCATEs every RLS-protected table with `CASCADE` so the suite
--      is idempotent when re-run against the same database. The
--      TRUNCATE is executed by the superuser outside any tenant
--      context — superuser bypasses RLS, so no extra tricks needed.
--   4. Seeds two studios (A, B) with deterministic UUIDs, six users
--      spread across them (member_A, member_A2, admin_A, coach_A in
--      studio A; member_B, admin_B in studio B), one class per studio,
--      one confirmed reservation per member, one workout session per
--      user and one audit_log row.
--   5. Creates two SQL helpers:
--        - `public.test_set_tenant(user_id, studio_id, role)` runs the
--          three `set_config(..., true)` calls plus
--          `SET LOCAL ROLE athlya_tenant_test` so policies are
--          actually enforced for the assertions that follow. The
--          `true` third argument makes the settings transaction-local,
--          matching the way `withTenant` scopes GUCs.
--        - `public.test_unset_tenant()` clears the three GUCs and
--          resets the role to the outer session user.
--
-- Seeding UUIDs follow the pattern `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
-- for studio A and `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb` for studio B
-- so the assertions stay human-readable. The `4` in position 13 and the
-- `8` in position 17 make them valid UUID v4 strings, which avoids
-- subtle pg parse errors on some Postgres builds.
--
-- NOTE: this file deliberately does NOT wrap its statements in
-- `BEGIN;` / `COMMIT;`. The per-table test files each open their own
-- transaction and roll it back at the end; bootstrap data persists
-- across them so a single `psql -f run-all.sql` invocation seeds once
-- and exercises every policy afterwards.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Extensions
-- ---------------------------------------------------------------------

DO $$
BEGIN
    BEGIN
        CREATE EXTENSION IF NOT EXISTS pgtap;
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'pgtap extension not creatable by this role; assuming it is already installed';
    END;
END$$;

-- ---------------------------------------------------------------------
-- 2. Non-superuser test role + table grants
--
-- Why a dedicated role:
--   Superusers always bypass RLS regardless of FORCE. If we kept the
--   assertions on the default `postgres` role every policy would
--   look like it permits everything, which would make the whole suite
--   false-pass. The `athlya_tenant_test` role has LOGIN stripped (it
--   is only reachable via SET ROLE) and no special attributes, so RLS
--   policies apply to it as they would to a real tenant connection.
-- ---------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_tenant_test') THEN
        CREATE ROLE athlya_tenant_test NOLOGIN NOBYPASSRLS;
    END IF;
END$$;

-- The role needs minimum DML grants on every table we test. We keep
-- this in sync with the schema by granting at the schema level after
-- confirming the tables exist; RLS policies then layer on top.
GRANT USAGE ON SCHEMA public TO athlya_tenant_test;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO athlya_tenant_test;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO athlya_tenant_test;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO athlya_tenant_test;

-- ---------------------------------------------------------------------
-- 3. Clean slate — TRUNCATE as superuser (RLS does not apply)
-- ---------------------------------------------------------------------

TRUNCATE TABLE
    "push_tokens",
    "idempotency_keys",
    "outbox",
    "audit_log",
    "workout_sessions",
    "reservations",
    "classes",
    "users",
    "studios"
RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------------
-- 4. Seed data
-- ---------------------------------------------------------------------

INSERT INTO "studios" (id, slug, name, brand_color) VALUES
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'studio-a', 'Studio Alpha', '#0EA5E9'),
    ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'studio-b', 'Studio Bravo', '#F97316');

INSERT INTO "users" (id, studio_id, email, display_name, role, consents) VALUES
    -- Studio A
    ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member-a@athlya.test',  'Member A',  'member', '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb),
    ('11111111-1111-4111-8111-111111111112', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member-a2@athlya.test', 'Member A2', 'member', '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb),
    ('11111111-1111-4111-8111-111111111113', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin-a@athlya.test',   'Admin A',   'admin',  '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb),
    ('11111111-1111-4111-8111-111111111114', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'coach-a@athlya.test',   'Coach A',   'coach',  '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb),
    -- Studio B
    ('22222222-2222-4222-8222-222222222221', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'member-b@athlya.test',  'Member B',  'member', '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb),
    ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'admin-b@athlya.test',   'Admin B',   'admin',  '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb);

INSERT INTO "classes" (id, studio_id, coach_id, title, starts_at, duration_min, capacity, version) VALUES
    ('cccccccc-cccc-4ccc-8ccc-ccccccccccca', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111114', 'Yoga Flow A', '2030-01-01 09:00:00+00', 60, 20, 0),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccb', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', NULL,                                   'Boxing B',    '2030-01-01 19:00:00+00', 45, 15, 0),
    -- Extra studio-A class used by reservations.sql to test
    -- INSERT policies without needing to create rows under the tenant
    -- role mid-test (that would require the class to be inserted by a
    -- role-admin first, which would obscure the reservation-policy
    -- assertion we actually care about).
    ('cccccccc-cccc-4ccc-8ccc-cccccccccc88', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', NULL,                                   'Extra A',     '2030-07-01 08:00:00+00', 45, 5,  0);

INSERT INTO "reservations" (id, class_id, user_id, status) VALUES
    ('dddddddd-dddd-4ddd-8ddd-dddddddddd01', 'cccccccc-cccc-4ccc-8ccc-ccccccccccca', '11111111-1111-4111-8111-111111111111', 'confirmed'),
    ('dddddddd-dddd-4ddd-8ddd-dddddddddd02', 'cccccccc-cccc-4ccc-8ccc-ccccccccccca', '11111111-1111-4111-8111-111111111112', 'confirmed'),
    ('dddddddd-dddd-4ddd-8ddd-dddddddddd03', 'cccccccc-cccc-4ccc-8ccc-cccccccccccb', '22222222-2222-4222-8222-222222222221', 'confirmed');

INSERT INTO "workout_sessions" (id, user_id, studio_id, started_at, exercises) VALUES
    ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-01-02 08:00:00+00', '[]'::jsonb),
    ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02', '11111111-1111-4111-8111-111111111112', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-01-02 10:00:00+00', '[]'::jsonb),
    ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeee03', '22222222-2222-4222-8222-222222222221', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2026-01-02 18:00:00+00', '[]'::jsonb);

INSERT INTO "audit_log" (actor_id, action, target_type, target_id, metadata) VALUES
    ('11111111-1111-4111-8111-111111111113', 'studio.created', 'studio', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"seed":"a"}'::jsonb),
    ('22222222-2222-4222-8222-222222222222', 'studio.created', 'studio', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '{"seed":"b"}'::jsonb);

INSERT INTO "outbox" (id, event_id, event_type, payload, occurred_at) VALUES
    ('ffffffff-ffff-4fff-8fff-ffffffffff01', 'evt-seed-a', 'test.seed', '{"studio":"a"}'::jsonb, '2026-01-01 00:00:00+00'),
    ('ffffffff-ffff-4fff-8fff-ffffffffff02', 'evt-seed-b', 'test.seed', '{"studio":"b"}'::jsonb, '2026-01-01 00:00:00+00');

INSERT INTO "idempotency_keys" (key, user_id, response, status_code, expires_at) VALUES
    ('key-seed-a', '11111111-1111-4111-8111-111111111111', '{"ok":true}'::jsonb, 200, '2099-01-01 00:00:00+00'),
    ('key-seed-b', '22222222-2222-4222-8222-222222222221', '{"ok":true}'::jsonb, 200, '2099-01-01 00:00:00+00');

INSERT INTO "push_tokens" (id, user_id, platform, token) VALUES
    ('99999999-9999-4999-8999-999999999901', '11111111-1111-4111-8111-111111111111', 'ios',     'token-seed-a'),
    ('99999999-9999-4999-8999-999999999902', '22222222-2222-4222-8222-222222222221', 'android', 'token-seed-b');

-- ---------------------------------------------------------------------
-- 5. Helper functions for tenant context
--
-- `test_set_tenant` is a plain SQL function over `set_config` so it can
-- be inlined by the planner and so its third-argument `true` makes each
-- setting transaction-local (rolled back by the enclosing ROLLBACK of
-- every per-table test file).
--
-- We intentionally do NOT touch the session role inside this function.
-- Each per-table test file issues its own `SET LOCAL ROLE
-- athlya_tenant_test;` right after `BEGIN;` — that is the *only*
-- reliable way to scope role switching to a transaction in PostgreSQL
-- without per-function `SET` options. The per-file `ROLLBACK` reverts
-- the role back to the session user automatically.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.test_set_tenant(p_user_id uuid, p_studio_id uuid, p_role text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM set_config('app.user_id',   p_user_id::text,   true);
    PERFORM set_config('app.studio_id', p_studio_id::text, true);
    PERFORM set_config('app.role',      p_role,            true);
END;
$$;

CREATE OR REPLACE FUNCTION public.test_unset_tenant()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM set_config('app.user_id',   '', true);
    PERFORM set_config('app.studio_id', '', true);
    PERFORM set_config('app.role',      '', true);
END;
$$;

-- The helpers must be callable by `athlya_tenant_test`: EXECUTE is
-- already granted by the schema-level GRANT above, but we add an
-- explicit grant here for future-proofing.
GRANT EXECUTE ON FUNCTION public.test_set_tenant(uuid, uuid, text) TO athlya_tenant_test;
GRANT EXECUTE ON FUNCTION public.test_unset_tenant() TO athlya_tenant_test;
