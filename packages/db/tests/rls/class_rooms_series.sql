-- =====================================================================
-- class_rooms_series.sql: migration 0051 under the real athlya_app /
-- athlya_cron roles (issue #748)
--
-- Asserts that:
--   - `rooms` is ENABLE + FORCE RLS, invisible to athlya_app without
--     tenant claims, and athlya_cron holds no privilege on it;
--   - athlya_app may SELECT and INSERT rooms, UPDATE only name,
--     capacity and deleted_at, and never DELETE;
--   - every role of a studio reads its own rooms only
--     (`rooms_read_same_studio`);
--   - only an admin of the studio creates and updates a room
--     (`rooms_insert_admin`, `rooms_update_admin`);
--   - a live room name is unique per studio regardless of case, and a
--     soft-deleted room frees its name;
--   - the composite key stops a class from pointing at another
--     studio's room, and a hard-deleted room clears `room_id` alone;
--   - `series_id` is a plain nullable column every class may carry.
--
-- Writes and their read-backs are separate statements: `app_studio_id()`
-- and friends are STABLE (see CLAUDE.md, pgTAP note).
-- =====================================================================

BEGIN;
SELECT plan(23);

-- ---------- seed (migration superuser) ----------

INSERT INTO rooms (id, studio_id, name, capacity) VALUES
    ('a0510000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Studio 1', 20),
    ('a0510000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Cycling room', NULL),
    ('a0510000-0000-4000-8000-000000000003', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Ring', 12);

-- ---------- hardening ----------

SELECT ok(
    (SELECT c.relrowsecurity AND c.relforcerowsecurity
       FROM pg_class c
      WHERE c.oid = 'rooms'::regclass),
    'rooms: ENABLE + FORCE ROW LEVEL SECURITY'
);

SELECT ok(
    has_table_privilege('athlya_app', 'rooms', 'SELECT')
    AND has_table_privilege('athlya_app', 'rooms', 'INSERT')
    AND NOT has_table_privilege('athlya_app', 'rooms', 'DELETE')
    AND NOT has_table_privilege('athlya_app', 'rooms', 'TRUNCATE'),
    'athlya_app: SELECT and INSERT on rooms, no DELETE'
);

SELECT ok(
    has_column_privilege('athlya_app', 'rooms', 'name', 'UPDATE')
    AND has_column_privilege('athlya_app', 'rooms', 'capacity', 'UPDATE')
    AND has_column_privilege('athlya_app', 'rooms', 'deleted_at', 'UPDATE')
    AND NOT has_column_privilege('athlya_app', 'rooms', 'studio_id', 'UPDATE')
    AND NOT has_column_privilege('athlya_app', 'rooms', 'id', 'UPDATE'),
    'athlya_app: UPDATE limited to name, capacity and deleted_at'
);

-- ---------- athlya_app without claims ----------

SET LOCAL ROLE athlya_app;
SELECT test_unset_tenant();

SELECT is((SELECT count(*)::int FROM rooms), 0,
    'athlya_app without tenant GUCs reads zero rooms');

-- ---------- member A ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member');

SELECT results_eq(
    $$ SELECT id FROM rooms ORDER BY id $$,
    $$ VALUES ('a0510000-0000-4000-8000-000000000001'::uuid), ('a0510000-0000-4000-8000-000000000002'::uuid) $$,
    'rooms_read_same_studio: a member reads the rooms of their studio, not another studio''s'
);

SELECT throws_ok(
    $$ INSERT INTO rooms (studio_id, name) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Member room') $$,
    '42501', NULL,
    'rooms_insert_admin: a member cannot create a room'
);

UPDATE rooms SET name = 'Member edit' WHERE id = 'a0510000-0000-4000-8000-000000000001';

SELECT is(
    (SELECT name FROM rooms WHERE id = 'a0510000-0000-4000-8000-000000000001'),
    'Studio 1',
    'rooms_update_admin: a member update matches no row'
);

-- ---------- coach A ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111114', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'coach');

SELECT is((SELECT count(*)::int FROM rooms), 2,
    'rooms_read_same_studio: a coach reads the two rooms of studio A');

SELECT throws_ok(
    $$ INSERT INTO rooms (studio_id, name) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Coach room') $$,
    '42501', NULL,
    'rooms_insert_admin: a coach cannot create a room'
);

-- ---------- admin A ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111113', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin');

SELECT lives_ok(
    $$ INSERT INTO rooms (id, studio_id, name, capacity)
       VALUES ('a0510000-0000-4000-8000-000000000004', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Mat room', 15) $$,
    'rooms_insert_admin: an admin creates a room in their studio'
);

SELECT throws_ok(
    $$ INSERT INTO rooms (studio_id, name) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Planted') $$,
    '42501', NULL,
    'rooms_insert_admin: an admin cannot create a room in another studio'
);

SELECT throws_ok(
    $$ INSERT INTO rooms (studio_id, name) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'STUDIO 1') $$,
    '23505', NULL,
    'a live room name is unique per studio regardless of case'
);

SELECT throws_ok(
    $$ INSERT INTO rooms (studio_id, name, capacity) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Tiny', 0) $$,
    '23514', NULL,
    'a room capacity below 1 is refused'
);

UPDATE rooms SET capacity = 25 WHERE id = 'a0510000-0000-4000-8000-000000000001';

SELECT is(
    (SELECT capacity FROM rooms WHERE id = 'a0510000-0000-4000-8000-000000000001'),
    25,
    'rooms_update_admin: an admin updates a room of their studio'
);

UPDATE rooms SET name = 'Hijacked' WHERE id = 'a0510000-0000-4000-8000-000000000003';

SELECT throws_ok(
    $$ UPDATE rooms SET studio_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        WHERE id = 'a0510000-0000-4000-8000-000000000004' $$,
    '42501', NULL,
    'athlya_app cannot move a room to another studio (no UPDATE on studio_id)'
);

SELECT throws_ok(
    $$ DELETE FROM rooms WHERE id = 'a0510000-0000-4000-8000-000000000004' $$,
    '42501', NULL,
    'athlya_app cannot hard-delete a room'
);

UPDATE rooms SET deleted_at = now() WHERE id = 'a0510000-0000-4000-8000-000000000002';

SELECT lives_ok(
    $$ INSERT INTO rooms (studio_id, name) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'cycling ROOM') $$,
    'a soft-deleted room frees its name'
);

SELECT lives_ok(
    $$ INSERT INTO classes (id, studio_id, title, starts_at, duration_min, capacity, room_id, series_id)
       VALUES ('c0510000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Roomed',
               '2030-02-01 09:00:00+00', 60, 10,
               'a0510000-0000-4000-8000-000000000001', 'f0510000-0000-4000-8000-000000000001') $$,
    'an admin creates a class in a room of their studio, as part of a series'
);

SELECT throws_ok(
    $$ INSERT INTO classes (studio_id, title, starts_at, duration_min, capacity, room_id)
       VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Wrong room', '2030-02-01 11:00:00+00', 60, 10,
               'a0510000-0000-4000-8000-000000000003') $$,
    '23503', NULL,
    'classes_room_fk: a class cannot point at another studio''s room'
);

UPDATE classes SET room_id = 'a0510000-0000-4000-8000-000000000004', version = version + 1
 WHERE id = 'c0510000-0000-4000-8000-000000000001';

SELECT is(
    (SELECT room_id FROM classes WHERE id = 'c0510000-0000-4000-8000-000000000001'),
    'a0510000-0000-4000-8000-000000000004'::uuid,
    'an admin moves a class to another room of their studio'
);

-- ---------- admin B ----------

SELECT test_set_tenant('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'admin');

SELECT results_eq(
    $$ SELECT name FROM rooms ORDER BY name $$,
    $$ VALUES ('Ring'::text) $$,
    'rooms_update_admin: admin A''s update of a studio B room matched no row; admin B reads only studio B'
);

-- ---------- hard delete (studio cascade path, superuser) ----------

RESET ROLE;

DELETE FROM rooms WHERE id = 'a0510000-0000-4000-8000-000000000004';

SELECT ok(
    (SELECT room_id IS NULL AND studio_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
       FROM classes WHERE id = 'c0510000-0000-4000-8000-000000000001'),
    'classes_room_fk: a hard-deleted room clears room_id and keeps studio_id'
);

-- ---------- athlya_cron ----------

SET LOCAL ROLE athlya_cron;

SELECT throws_ok(
    $$ SELECT count(*) FROM rooms $$,
    '42501', NULL,
    'athlya_cron holds no privilege on rooms'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
