-- =====================================================================
-- audit_log.sql — admin-only read + append-only immutability
--
-- Covered policies (Req 13.4, 22.2, 22.3):
--   - audit_admin_only   SELECT USING app_role() = 'admin'
--   - audit_no_insert    INSERT WITH CHECK false   (bypass via service role)
--   - audit_no_update    UPDATE USING false        (belt-and-braces)
--   - audit_no_delete    DELETE USING false        (belt-and-braces)
--
-- Additionally, the `audit_log_immutable()` trigger installed in
-- 0000_init.sql raises `audit_log is append-only` on UPDATE / DELETE,
-- independently of RLS. Together they give a two-layer defence:
--
--   * Application role: stopped by RLS (SQLSTATE 42501 on INSERT, or
--     zero rows affected / 42501 on UPDATE + DELETE because
--     `USING (false)` filters every row out before the trigger runs).
--   * Superuser / BYPASSRLS role: stopped by the trigger, which raises
--     SQLSTATE P0001 with message 'audit_log is append-only'.
--
-- Our assertions accept either outcome depending on which layer fires
-- first: RLS's `USING (false)` silently strips rows (zero rows affected)
-- without ever reaching the trigger, whereas a session with RLS
-- disabled (e.g. a BYPASSRLS service role, or the superuser session we
-- restore via `RESET ROLE` at the end of this file) has its UPDATE /
-- DELETE raise 'audit_log is append-only' from the trigger. We cover
-- both: zero-rows-affected under the tenant role, then `throws_ok`
-- after `RESET ROLE`.
-- =====================================================================

BEGIN;
-- Switch to the non-superuser test role so RLS policies actually
-- apply. The session role (postgres) is a superuser and therefore
-- bypasses RLS; the enclosing ROLLBACK restores it at file end. The
-- last block in this file issues `RESET ROLE` to exercise the
-- audit_log_immutable() trigger independently of RLS.
SET LOCAL ROLE athlya_tenant_test;
SELECT plan(9);

-- ---------- audit_admin_only: member sees nothing ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111111',  -- member A
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

SELECT is(
    (SELECT count(*)::int FROM "audit_log"),
    0,
    'audit_admin_only: member role sees zero audit rows'
);

-- Coach also has zero read access (policy is admin-only).
SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111114',  -- coach A
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'coach'
);

SELECT is(
    (SELECT count(*)::int FROM "audit_log"),
    0,
    'audit_admin_only: coach role sees zero audit rows'
);

-- ---------- audit_admin_only: admin sees rows ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111113',  -- admin A
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'admin'
);

SELECT cmp_ok(
    (SELECT count(*)::int FROM "audit_log"),
    '>',
    0,
    'audit_admin_only: admin role can read audit rows (non-empty)'
);

-- ---------- audit_no_insert: any INSERT from the tenant context fails ----------

SELECT throws_ok(
    $$INSERT INTO "audit_log" (actor_id, action, metadata)
      VALUES ('11111111-1111-4111-8111-111111111113', 'forged', '{}'::jsonb)$$,
    '42501',
    NULL,
    'audit_no_insert: admin cannot INSERT into audit_log via RLS (SQLSTATE 42501)'
);

-- Even the member path fails with the same SQLSTATE.
SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

SELECT throws_ok(
    $$INSERT INTO "audit_log" (actor_id, action, metadata)
      VALUES ('11111111-1111-4111-8111-111111111111', 'forged', '{}'::jsonb)$$,
    '42501',
    NULL,
    'audit_no_insert: member cannot INSERT into audit_log via RLS (SQLSTATE 42501)'
);

-- ---------- audit_no_update via RLS ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111113',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'admin'
);

-- `USING (false)` strips every row: 0 rows updated rather than a raise.
-- We assert the "zero rows updated" outcome explicitly.
WITH upd AS (
    UPDATE "audit_log" SET action = 'tampered'
    WHERE action = 'studio.created'
    RETURNING id
)
SELECT is(count(*)::int, 0, 'audit_no_update (RLS): admin UPDATE of audit_log affects zero rows (USING false filters all)') FROM upd;

-- ---------- audit_no_delete via RLS ----------

WITH del AS (
    DELETE FROM "audit_log" WHERE action = 'studio.created' RETURNING id
)
SELECT is(count(*)::int, 0, 'audit_no_delete (RLS): admin DELETE of audit_log affects zero rows (USING false filters all)') FROM del;

-- ---------- audit trigger: immutability under any privilege level ----------
-- The `audit_log_immutable()` trigger installed in 0000_init.sql
-- raises 'audit_log is append-only' on UPDATE / DELETE regardless of
-- role. To observe it independently of RLS we need a role that
-- bypasses RLS — the outer session role (superuser in CI) does. We
-- RESET ROLE for the remainder of this transaction; the enclosing
-- ROLLBACK restores the test role indirectly by rewinding everything.

RESET ROLE;

SELECT throws_ok(
    $$UPDATE "audit_log" SET action = 'tampered' WHERE action = 'studio.created'$$,
    NULL,
    'audit_log is append-only',
    'audit_log_immutable trigger: UPDATE raises "audit_log is append-only"'
);

SELECT throws_ok(
    $$DELETE FROM "audit_log" WHERE action = 'studio.created'$$,
    NULL,
    'audit_log is append-only',
    'audit_log_immutable trigger: DELETE raises "audit_log is append-only"'
);

SELECT * FROM finish();
ROLLBACK;
