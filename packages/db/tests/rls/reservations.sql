-- =====================================================================
-- reservations.sql — exercises every `reservations_*` policy
--
-- Covered policies:
--   - reservations_read_own                SELECT USING user_id = app_user_id()
--   - reservations_read_admin_same_studio  SELECT USING role IN ('admin','coach')
--                                                    AND EXISTS(class.studio_id = app_studio_id())
--   - reservations_insert_own              INSERT WITH CHECK user_id = app_user_id()
--                                                    AND EXISTS(class.studio_id = app_studio_id())
--   - reservations_update_own              UPDATE USING+CHECK user_id = app_user_id()
--   - reservations_update_admin            UPDATE USING+CHECK role='admin' AND class.studio_id matches
--
-- Requirement mapping: 13.3, 13.6.
-- =====================================================================

BEGIN;
-- Switch to the non-superuser test role so RLS policies actually
-- apply. The session role (postgres) is a superuser and therefore
-- bypasses RLS; the enclosing ROLLBACK restores it at file end.
SET LOCAL ROLE athlya_tenant_test;
SELECT plan(12);

-- ---------- reservations_read_own (member) ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111111',  -- member A
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

SELECT is(
    (SELECT count(*)::int FROM "reservations" WHERE user_id = '11111111-1111-4111-8111-111111111111'),
    1,
    'reservations_read_own: member A sees own reservation'
);

-- Cross-tenant reservation invisible to member.
SELECT is_empty(
    $$SELECT id FROM "reservations" WHERE user_id = '22222222-2222-4222-8222-222222222221'$$,
    'reservations_read_own: member A does NOT see member B reservation (cross-tenant hidden)'
);

-- Other member of same studio still invisible to a plain member (the
-- same-studio visibility is gated on role admin/coach).
SELECT is_empty(
    $$SELECT id FROM "reservations" WHERE user_id = '11111111-1111-4111-8111-111111111112'$$,
    'reservations_read_own: member A cannot peek at another member of same studio'
);

-- ---------- reservations_read_admin_same_studio (admin) ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111113',  -- admin A
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'admin'
);

-- Admin should see both reservations of studio A (member_A + member_A2).
SELECT is(
    (SELECT count(*)::int
     FROM "reservations" r
     JOIN "classes" c ON c.id = r.class_id
     WHERE c.studio_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    2,
    'reservations_read_admin_same_studio: admin A sees both studio-A reservations'
);

-- Admin must NOT see studio B reservation.
SELECT is_empty(
    $$SELECT r.id FROM "reservations" r
      JOIN "classes" c ON c.id = r.class_id
      WHERE c.studio_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
    'reservations_read_admin_same_studio: admin A does NOT see studio-B reservations'
);

-- ---------- reservations_insert_own (success) ----------

-- Member A2 has no reservation on the Extra-A class (id ...cc88) — that
-- class was seeded in 00_bootstrap specifically to exercise INSERT.
SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111112',  -- member A2
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

SELECT lives_ok(
    $$INSERT INTO "reservations" (class_id, user_id, status)
      VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccc88', '11111111-1111-4111-8111-111111111112', 'confirmed')$$,
    'reservations_insert_own: member A2 can INSERT own reservation'
);

-- ---------- reservations_insert_own (forge cross-tenant) ----------

SELECT throws_ok(
    $$INSERT INTO "reservations" (class_id, user_id, status)
      VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccc88', '22222222-2222-4222-8222-222222222221', 'confirmed')$$,
    '42501',
    NULL,
    'reservations_insert_own: member A2 cannot INSERT reservation with user_id = member B (SQLSTATE 42501)'
);

-- ---------- reservations_insert_own (cross-studio class denied) ----------
-- Regression: original policy only checked user_id. A member token from studio A
-- could book a class owned by studio B. The policy now requires class.studio_id
-- to match app_studio_id(). (Migration 0022.)

SELECT throws_ok(
    $$INSERT INTO "reservations" (class_id, user_id, status)
      VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccb', '11111111-1111-4111-8111-111111111112', 'confirmed')$$,
    '42501',
    NULL,
    'reservations_insert_own: member A2 (studio A) cannot INSERT reservation for a studio-B class (SQLSTATE 42501)'
);

-- ---------- reservations_update_own ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111111',  -- member A
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

WITH upd AS (
    UPDATE "reservations" SET status = 'cancelled', cancelled_at = now()
    WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddd01'
    RETURNING id
)
SELECT is(count(*)::int, 1, 'reservations_update_own: member A can cancel own reservation') FROM upd;

-- Cross-tenant UPDATE strips row out: zero rows affected.
WITH upd AS (
    UPDATE "reservations" SET status = 'cancelled'
    WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddd03'
    RETURNING id
)
SELECT is(count(*)::int, 0, 'reservations_update_own: member A cannot UPDATE member B reservation (zero rows affected)') FROM upd;

-- ---------- reservations_update_admin (same-studio success) ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111113',  -- admin A
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'admin'
);

WITH upd AS (
    UPDATE "reservations" SET status = 'cancelled'
    WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddd02'
    RETURNING id
)
SELECT is(count(*)::int, 1, 'reservations_update_admin: admin A can cancel a member-of-A reservation') FROM upd;

-- ---------- reservations_update_admin (cross-tenant denied) ----------

WITH upd AS (
    UPDATE "reservations" SET status = 'cancelled'
    WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddd03'
    RETURNING id
)
SELECT is(count(*)::int, 0, 'reservations_update_admin: admin A cannot UPDATE studio-B reservation (zero rows affected)') FROM upd;

-- ---------- defense in depth: member cannot SELECT cross-tenant ----------
-- Even after all the mutations above, a cross-tenant SELECT stays empty.

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

SELECT is_empty(
    $$SELECT id FROM "reservations" WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddd03'$$,
    'reservations_read_own: post-mutation, member A still does not see studio-B reservation'
);

SELECT * FROM finish();
ROLLBACK;
