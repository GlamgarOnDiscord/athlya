-- =====================================================================
-- classes.sql — exercises every `classes_*` policy
--
-- Covered policies (Req 13.6):
--   - classes_read_same_studio  SELECT USING studio_id = app_studio_id()
--   - classes_insert_admin      INSERT WITH CHECK studio_id = A + role admin
--   - classes_update_admin      UPDATE USING+CHECK same
--   - classes_delete_admin      DELETE USING same
--
-- For INSERT we assert that a member cannot sneak a row into their own
-- studio: the WITH CHECK predicate fails and Postgres raises
-- `new row violates row-level security policy` with SQLSTATE 42501.
-- pgTAP's `throws_ok(sql, sqlstate)` catches that.
-- For UPDATE / DELETE, a missing row after RLS filtering translates to
-- "zero rows affected" rather than a raise.
-- =====================================================================

BEGIN;
-- Switch to the non-superuser test role so RLS policies actually
-- apply. The session role (postgres) is a superuser and therefore
-- bypasses RLS; the enclosing ROLLBACK restores it at file end.
SET LOCAL ROLE athlya_tenant_test;
SELECT plan(10);

-- ---------- classes_read_same_studio ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111111',  -- member A
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

SELECT is(
    (SELECT count(*)::int FROM "classes" WHERE studio_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    1,
    'classes_read_same_studio: member A sees studio A class'
);

SELECT is_empty(
    $$SELECT id FROM "classes" WHERE studio_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
    'classes_read_same_studio: member A does NOT see studio B classes (cross-tenant hidden)'
);

-- ---------- classes_insert_admin (success for admin) ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111113',  -- admin A
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'admin'
);

SELECT lives_ok(
    $$INSERT INTO "classes" (studio_id, title, starts_at, duration_min, capacity)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Admin-inserted A', '2030-06-01 09:00:00+00', 45, 10)$$,
    'classes_insert_admin: admin A can INSERT a class into studio A'
);

-- ---------- classes_insert_admin (fail for member) ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111111',  -- member A
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

SELECT throws_ok(
    $$INSERT INTO "classes" (studio_id, title, starts_at, duration_min, capacity)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Member-forged', '2030-06-01 09:00:00+00', 45, 10)$$,
    '42501',
    NULL,
    'classes_insert_admin: member A cannot INSERT a class (SQLSTATE 42501 from WITH CHECK)'
);

-- ---------- classes_insert_admin (admin cannot cross-tenant) ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111113',  -- admin A
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'admin'
);

SELECT throws_ok(
    $$INSERT INTO "classes" (studio_id, title, starts_at, duration_min, capacity)
      VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Admin-A-forges-B', '2030-06-01 09:00:00+00', 45, 10)$$,
    '42501',
    NULL,
    'classes_insert_admin: admin A cannot INSERT a class into studio B (cross-tenant WITH CHECK fails)'
);

-- ---------- classes_update_admin (success for admin) ----------

WITH upd AS (
    UPDATE "classes" SET title = 'Admin-renamed A'
    WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccca'
    RETURNING id
)
SELECT is(count(*)::int, 1, 'classes_update_admin: admin A can UPDATE a class of studio A') FROM upd;

-- ---------- classes_update_admin (fail cross-tenant) ----------

WITH upd AS (
    UPDATE "classes" SET title = 'hacked'
    WHERE id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccb'
    RETURNING id
)
SELECT is(count(*)::int, 0, 'classes_update_admin: admin A cannot UPDATE studio B class (zero rows affected)') FROM upd;

-- ---------- classes_update_admin (member denied) ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

WITH upd AS (
    UPDATE "classes" SET title = 'member-renamed'
    WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccca'
    RETURNING id
)
SELECT is(count(*)::int, 0, 'classes_update_admin: member A cannot UPDATE own-studio class (zero rows affected)') FROM upd;

-- ---------- classes_delete_admin (admin success) ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111113',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'admin'
);

-- Delete a throwaway class freshly inserted so we do not disturb the
-- seed data reused by other files (this one happens inside a ROLLBACK,
-- so it is harmless anyway).
INSERT INTO "classes" (id, studio_id, title, starts_at, duration_min, capacity)
VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccc99', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Throwaway', '2030-06-02 09:00:00+00', 30, 5);

WITH del AS (
    DELETE FROM "classes" WHERE id = 'cccccccc-cccc-4ccc-8ccc-cccccccccc99'
    RETURNING id
)
SELECT is(count(*)::int, 1, 'classes_delete_admin: admin A can DELETE a class of studio A') FROM del;

-- ---------- classes_delete_admin (cross-tenant) ----------

WITH del AS (
    DELETE FROM "classes" WHERE id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccb'
    RETURNING id
)
SELECT is(count(*)::int, 0, 'classes_delete_admin: admin A cannot DELETE studio B class (zero rows affected)') FROM del;

-- ---------- classes_delete_admin (member denied) ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

WITH del AS (
    DELETE FROM "classes" WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccca'
    RETURNING id
)
SELECT is(count(*)::int, 0, 'classes_delete_admin: member A cannot DELETE own-studio class (zero rows affected)') FROM del;

SELECT * FROM finish();
ROLLBACK;
