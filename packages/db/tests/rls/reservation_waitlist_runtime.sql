-- =====================================================================
-- reservation_waitlist_runtime.sql — migration 0040 under the real
-- athlya_app / athlya_cron roles (issue #117)
--
-- Asserts that:
--   - with member claims, the raw locking class read and the raw
--     waitlist scan are clipped by RLS (the bugs 0040 fixes), while
--     `reservation_lock_class_for_cancel`, `reservation_waitlist_ahead`
--     and `reservation_promote_oldest_waitlist` see the whole class,
--     only for a class of the caller's studio the caller holds a
--     reservation on;
--   - the promotion is FIFO, respects capacity, and the caller can
--     write the `reservation.promoted` outbox row in the same
--     transaction;
--   - athlya_cron cannot read classes directly but gets every active
--     class, across studios, from `capacity_reconcile_snapshot`;
--   - every function is SECURITY DEFINER, owned by athlya_owner, with a
--     pinned search_path and EXECUTE for a single runtime role.
--
-- Writes and their read-backs are separate statements (STABLE snapshot,
-- see CLAUDE.md pgTAP note).
-- =====================================================================

BEGIN;
SELECT plan(26);

-- Seed as the migration superuser. Class W (studio A, capacity 1):
-- member A confirmed, member A2 then coach A on the waitlist. Member A
-- also holds a seat on "Extra A", whose waitlist is empty. A past
-- class in studio B must not reach the reconcile snapshot.
INSERT INTO classes (id, studio_id, title, starts_at, duration_min, capacity, version) VALUES
    ('cccccccc-cccc-4ccc-8ccc-cccccccc0040', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Waitlist A', '2030-08-01 09:00:00+00', 60, 1, 0),
    ('cccccccc-cccc-4ccc-8ccc-cccccccc0041', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Past B',     '2020-01-01 09:00:00+00', 60, 5, 0);

INSERT INTO reservations (id, class_id, user_id, status, created_at) VALUES
    ('dddddddd-dddd-4ddd-8ddd-dddddddd0401', 'cccccccc-cccc-4ccc-8ccc-cccccccc0040', '11111111-1111-4111-8111-111111111111', 'confirmed', '2026-01-01 00:00:00+00'),
    ('dddddddd-dddd-4ddd-8ddd-dddddddd0402', 'cccccccc-cccc-4ccc-8ccc-cccccccc0040', '11111111-1111-4111-8111-111111111112', 'waitlist',  '2026-01-02 00:00:00+00'),
    ('dddddddd-dddd-4ddd-8ddd-dddddddd0403', 'cccccccc-cccc-4ccc-8ccc-cccccccc0040', '11111111-1111-4111-8111-111111111114', 'waitlist',  '2026-01-03 00:00:00+00'),
    ('dddddddd-dddd-4ddd-8ddd-dddddddd0404', 'cccccccc-cccc-4ccc-8ccc-cccccccccc88', '11111111-1111-4111-8111-111111111111', 'confirmed', '2026-01-01 00:00:00+00');

-- ---------- hardening ----------

SELECT ok(
    (SELECT bool_and(
                p.prosecdef
            AND pg_get_userbyid(p.proowner) = 'athlya_owner'
            AND 'search_path=public, pg_temp' = ANY (p.proconfig)
            AND has_function_privilege('athlya_app', p.oid, 'EXECUTE')
            AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
            AND NOT has_function_privilege('athlya_cron', p.oid, 'EXECUTE'))
       FROM pg_proc p
      WHERE p.oid IN ('reservation_lock_class_for_cancel(uuid)'::regprocedure,
                      'reservation_promote_oldest_waitlist(uuid)'::regprocedure,
                      'reservation_waitlist_ahead(uuid, timestamptz)'::regprocedure)),
    '0040 reservation functions: SECURITY DEFINER, athlya_owner, pinned search_path, athlya_app only'
);

SELECT ok(
    (SELECT p.prosecdef
        AND pg_get_userbyid(p.proowner) = 'athlya_owner'
        AND 'search_path=public, pg_temp' = ANY (p.proconfig)
        AND has_function_privilege('athlya_cron', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('athlya_app', p.oid, 'EXECUTE')
       FROM pg_proc p
      WHERE p.oid = 'capacity_reconcile_snapshot()'::regprocedure),
    'capacity_reconcile_snapshot: SECURITY DEFINER, athlya_owner, pinned search_path, athlya_cron only'
);

-- ---------- member A (confirmed on W) ----------

SET LOCAL ROLE athlya_app;
SELECT test_set_tenant('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member');

SELECT is_empty(
    $$ SELECT id FROM classes WHERE id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0040' FOR UPDATE $$,
    'raw SELECT ... FOR UPDATE on classes is empty for a member (classes_update_admin)'
);

SELECT is(
    (SELECT count(*)::int FROM reservations
      WHERE class_id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0040' AND status = 'waitlist'),
    0,
    'raw waitlist scan is clipped to the member''s own rows (reservations_read_own)'
);

SELECT is(
    reservation_lock_class_for_cancel('cccccccc-cccc-4ccc-8ccc-cccccccc0040'),
    '2030-08-01 09:00:00+00'::timestamptz,
    'reservation_lock_class_for_cancel: returns starts_at for a class the member booked'
);

SELECT is(
    reservation_lock_class_for_cancel('cccccccc-cccc-4ccc-8ccc-cccccccccccb'),
    NULL::timestamptz,
    'reservation_lock_class_for_cancel: NULL for another studio''s class'
);

SELECT is(
    reservation_waitlist_ahead('cccccccc-cccc-4ccc-8ccc-cccccccc0040', '2026-01-03 00:00:00+00'),
    NULL::integer,
    'reservation_waitlist_ahead: NULL for a caller who is not waitlisted on the class'
);

-- ---------- member A2 (first on W's waitlist) ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111112', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member');

SELECT is(
    reservation_waitlist_ahead('cccccccc-cccc-4ccc-8ccc-cccccccc0040', '2026-01-02 00:00:00+00'),
    0,
    'reservation_waitlist_ahead: the oldest waiter has nobody ahead'
);

SELECT is(
    reservation_waitlist_ahead('cccccccc-cccc-4ccc-8ccc-cccccccc0040', '2026-01-03 00:00:00+00'),
    1,
    'reservation_waitlist_ahead: counts other members'' waitlist rows'
);

SELECT is(
    reservation_lock_class_for_cancel('cccccccc-cccc-4ccc-8ccc-cccccccccc88'),
    NULL::timestamptz,
    'reservation_lock_class_for_cancel: NULL for a same-studio class the caller has not booked'
);

-- ---------- member B (other studio) ----------

SELECT test_set_tenant('22222222-2222-4222-8222-222222222221', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'member');

SELECT is(
    reservation_waitlist_ahead('cccccccc-cccc-4ccc-8ccc-cccccccc0040', '2026-01-03 00:00:00+00'),
    NULL::integer,
    'reservation_waitlist_ahead: NULL for another studio''s class'
);

SELECT throws_ok(
    $$ SELECT * FROM reservation_promote_oldest_waitlist('cccccccc-cccc-4ccc-8ccc-cccccccc0040') $$,
    '42501',
    NULL,
    'reservation_promote_oldest_waitlist: refuses another studio''s class'
);

-- ---------- member A cancels W: promotion ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member');

SELECT is(
    (SELECT outcome FROM reservation_promote_oldest_waitlist('cccccccc-cccc-4ccc-8ccc-cccccccc0040')),
    'no_capacity',
    'reservation_promote_oldest_waitlist: no promotion while the class is full'
);

UPDATE reservations SET status = 'cancelled', cancelled_at = now()
 WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddd0401';

SELECT results_eq(
    $$ SELECT outcome, reservation_id, user_id
         FROM reservation_promote_oldest_waitlist('cccccccc-cccc-4ccc-8ccc-cccccccc0040') $$,
    $$ VALUES ('promoted'::text,
               'dddddddd-dddd-4ddd-8ddd-dddddddd0402'::uuid,
               '11111111-1111-4111-8111-111111111112'::uuid) $$,
    'reservation_promote_oldest_waitlist: promotes the oldest waiter of another member'
);

SELECT lives_ok(
    $$ INSERT INTO outbox (event_id, event_type, payload, occurred_at)
       VALUES ('evt-0040-promoted', 'reservation.promoted',
               '{"reservationId":"dddddddd-dddd-4ddd-8ddd-dddddddd0402"}'::jsonb, now()) $$,
    'the caller writes the reservation.promoted outbox row in the same transaction'
);

SELECT is(
    (SELECT outcome FROM reservation_promote_oldest_waitlist('cccccccc-cccc-4ccc-8ccc-cccccccc0040')),
    'no_capacity',
    'reservation_promote_oldest_waitlist: the promoted waiter filled the freed seat'
);

SELECT results_eq(
    $$ SELECT outcome, reservation_id, user_id
         FROM reservation_promote_oldest_waitlist('cccccccc-cccc-4ccc-8ccc-cccccccccc88') $$,
    $$ VALUES ('no_waiter'::text, NULL::uuid, NULL::uuid) $$,
    'reservation_promote_oldest_waitlist: no_waiter on an empty waitlist'
);

SELECT throws_ok(
    $$ SELECT * FROM reservation_promote_oldest_waitlist('cccccccc-cccc-4ccc-8ccc-cccccccccccb') $$,
    '42501',
    NULL,
    'reservation_promote_oldest_waitlist: refuses a class of another studio for member A'
);

SELECT test_unset_tenant();

SELECT throws_ok(
    $$ SELECT * FROM reservation_promote_oldest_waitlist('cccccccc-cccc-4ccc-8ccc-cccccccc0040') $$,
    '42501',
    NULL,
    'reservation_promote_oldest_waitlist: refuses a caller without claims'
);

SELECT throws_ok(
    $$ SELECT * FROM capacity_reconcile_snapshot() $$,
    '42501',
    NULL,
    'athlya_app cannot execute capacity_reconcile_snapshot'
);

RESET ROLE;

SELECT results_eq(
    $$ SELECT id, status::text FROM reservations
        WHERE class_id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0040' ORDER BY id $$,
    $$ VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddd0401'::uuid, 'cancelled'),
              ('dddddddd-dddd-4ddd-8ddd-dddddddd0402'::uuid, 'confirmed'),
              ('dddddddd-dddd-4ddd-8ddd-dddddddd0403'::uuid, 'waitlist') $$,
    'FIFO: only the oldest waiter was promoted, the next one is still waiting'
);

-- ---------- athlya_cron: capacity reconcile ----------

SET LOCAL ROLE athlya_cron;

SELECT throws_ok(
    $$ SELECT id FROM classes $$,
    '42501',
    NULL,
    'athlya_cron still cannot read classes directly'
);

SELECT results_eq(
    $$ SELECT capacity, confirmed FROM capacity_reconcile_snapshot()
        WHERE class_id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0040' $$,
    $$ VALUES (1, 1) $$,
    'capacity_reconcile_snapshot: capacity and confirmed count of an active class'
);

SELECT ok(
    (SELECT count(*) = 3
       FROM capacity_reconcile_snapshot()
      WHERE class_id IN ('cccccccc-cccc-4ccc-8ccc-ccccccccccca',
                         'cccccccc-cccc-4ccc-8ccc-cccccccccccb',
                         'cccccccc-cccc-4ccc-8ccc-cccccccccc88')),
    'capacity_reconcile_snapshot: covers the active classes of every studio'
);

SELECT is_empty(
    $$ SELECT 1 FROM capacity_reconcile_snapshot()
        WHERE class_id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0041' $$,
    'capacity_reconcile_snapshot: skips classes that already started'
);

SELECT throws_ok(
    $$ SELECT * FROM reservation_promote_oldest_waitlist('cccccccc-cccc-4ccc-8ccc-cccccccc0040') $$,
    '42501',
    NULL,
    'athlya_cron cannot execute reservation_promote_oldest_waitlist'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
