-- =====================================================================
-- checkin_runtime.sql — migration 0045 under the real athlya_app role
-- (issue #654)
--
-- Asserts that:
--   - a coach cannot stamp `checked_in_at` with a raw UPDATE
--     (`reservations_update_admin` admits admins only — the bug 0045
--     fixes), but can through `checkin_mark_reservation`;
--   - the function stamps once, only a confirmed reservation of a live
--     class of the caller's studio, and refuses member callers (42501);
--   - the function is SECURITY DEFINER, owned by athlya_owner, with a
--     pinned search_path and EXECUTE for athlya_app only.
--
-- Writes and their read-backs are separate statements (STABLE snapshot,
-- see CLAUDE.md pgTAP note).
-- =====================================================================

BEGIN;
SELECT plan(12);

-- Seed as the migration superuser: a cancelled reservation of member A2
-- on "Extra A", and a confirmed one on a class of studio A that is then
-- soft-deleted (the capacity trigger refuses a confirmed row on a class
-- that is already deleted).
INSERT INTO classes (id, studio_id, title, starts_at, duration_min, capacity, version) VALUES
    ('cccccccc-cccc-4ccc-8ccc-cccccccc0045', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Deleted A', '2030-09-01 09:00:00+00', 60, 5, 0);

INSERT INTO reservations (id, class_id, user_id, status, cancelled_at) VALUES
    ('dddddddd-dddd-4ddd-8ddd-dddddddd0451', 'cccccccc-cccc-4ccc-8ccc-cccccccccc88', '11111111-1111-4111-8111-111111111112', 'cancelled', '2026-01-01 00:00:00+00');
INSERT INTO reservations (id, class_id, user_id, status) VALUES
    ('dddddddd-dddd-4ddd-8ddd-dddddddd0452', 'cccccccc-cccc-4ccc-8ccc-cccccccc0045', '11111111-1111-4111-8111-111111111112', 'confirmed');

UPDATE classes SET deleted_at = '2026-01-01 00:00:00+00'
 WHERE id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0045';

-- ---------- hardening ----------

SELECT ok(
    (SELECT p.prosecdef
        AND pg_get_userbyid(p.proowner) = 'athlya_owner'
        AND 'search_path=public, pg_temp' = ANY (p.proconfig)
        AND has_function_privilege('athlya_app', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('athlya_cron', p.oid, 'EXECUTE')
       FROM pg_proc p
      WHERE p.oid = 'checkin_mark_reservation(uuid, timestamptz)'::regprocedure),
    'checkin_mark_reservation: SECURITY DEFINER, athlya_owner, pinned search_path, athlya_app only'
);

SET LOCAL ROLE athlya_app;

-- ---------- coach A ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111114', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'coach');

SELECT is_empty(
    $$ UPDATE reservations SET checked_in_at = now()
        WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddd01' RETURNING id $$,
    'raw UPDATE of checked_in_at matches nothing for a coach (reservations_update_admin)'
);

SELECT results_eq(
    $$ SELECT id, user_id, checked_in_at FROM checkin_mark_reservation(
           'dddddddd-dddd-4ddd-8ddd-dddddddddd01', '2030-01-01 08:45:00+00') $$,
    $$ VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddd01'::uuid,
               '11111111-1111-4111-8111-111111111111'::uuid,
               '2030-01-01 08:45:00+00'::timestamptz) $$,
    'checkin_mark_reservation: a coach stamps a confirmed reservation of the studio'
);

SELECT is(
    (SELECT checked_in_at FROM reservations WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddd01'),
    '2030-01-01 08:45:00+00'::timestamptz,
    'checkin_mark_reservation: the stamp is persisted'
);

SELECT is(
    (SELECT status::text FROM reservations WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddd01'),
    'confirmed',
    'checkin_mark_reservation: the status is untouched'
);

SELECT is_empty(
    $$ SELECT id FROM checkin_mark_reservation(
           'dddddddd-dddd-4ddd-8ddd-dddddddddd01', '2030-01-01 08:50:00+00') $$,
    'checkin_mark_reservation: a second stamp of the same reservation returns nothing'
);

SELECT is(
    (SELECT checked_in_at FROM reservations WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddd01'),
    '2030-01-01 08:45:00+00'::timestamptz,
    'checkin_mark_reservation: the first stamp is kept'
);

SELECT is_empty(
    $$ SELECT id FROM checkin_mark_reservation(
           'dddddddd-dddd-4ddd-8ddd-dddddddd0441', now()) $$,
    'checkin_mark_reservation: a cancelled reservation is not stamped'
);

SELECT is_empty(
    $$ SELECT id FROM checkin_mark_reservation(
           'dddddddd-dddd-4ddd-8ddd-dddddddd0442', now()) $$,
    'checkin_mark_reservation: a reservation of a deleted class is not stamped'
);

SELECT is_empty(
    $$ SELECT id FROM checkin_mark_reservation(
           'dddddddd-dddd-4ddd-8ddd-dddddddddd03', now()) $$,
    'checkin_mark_reservation: another studio''s reservation is not stamped'
);

-- ---------- admin B ----------

SELECT test_set_tenant('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'admin');

SELECT is_empty(
    $$ SELECT id FROM checkin_mark_reservation(
           'dddddddd-dddd-4ddd-8ddd-dddddddddd02', now()) $$,
    'checkin_mark_reservation: an admin of studio B cannot stamp a studio A reservation'
);

-- ---------- member A2 ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111112', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member');

SELECT throws_ok(
    $$ SELECT * FROM checkin_mark_reservation('dddddddd-dddd-4ddd-8ddd-dddddddddd02', now()) $$,
    '42501',
    NULL,
    'checkin_mark_reservation: a member cannot check themselves in'
);

SELECT * FROM finish();
ROLLBACK;
