-- =====================================================================
-- booking_holds_fencing.sql: migration 0050 (issue #723)
--
-- Asserts that:
--   - an unexpired hold takes a seat for the capacity trigger, an
--     expired one does not, and holds are bounded (expiry required, at
--     most 30 minutes, never extended, never reopened);
--   - confirming an active hold succeeds on a full class, confirming an
--     expired one is refused, and a non-hold row never keeps an expiry;
--   - one live row (confirmed, waitlist or pending) per member and class;
--   - the classes guard refuses a capacity below confirmed + active
--     holds, a move of a started class or into the past, and a capacity
--     or start change that does not bump `version`;
--   - `reservation_lock_class_for_booking` returns the version of a class
--     of the caller's studio only;
--   - the cron sweep expires holds and promotes the oldest waiter with
--     its outbox row, as athlya_cron, which still cannot read the tables;
--   - the cancellation promotion and the reconcile snapshot count holds;
--   - grants, ownership and search_path of every 0050 function.
--
-- Now() is the transaction start time, so an expired hold is seeded
-- with triggers off (`session_replication_role = replica`). Writes and
-- their read-backs are separate statements (STABLE snapshot, CLAUDE.md).
-- =====================================================================

BEGIN;
SELECT plan(43);

-- ---------- hardening ----------

SELECT ok(
    (SELECT bool_and(
                p.prosecdef
            AND pg_get_userbyid(p.proowner) = 'athlya_owner'
            AND 'search_path=public, pg_temp' = ANY (p.proconfig))
       FROM pg_proc p
      WHERE p.oid IN ('enforce_class_capacity()'::regprocedure,
                      'guard_class_schedule()'::regprocedure)),
    'trigger functions: SECURITY DEFINER, athlya_owner, pinned search_path'
);

SELECT ok(
    (SELECT p.prosecdef
        AND pg_get_userbyid(p.proowner) = 'athlya_owner'
        AND 'search_path=public, pg_temp' = ANY (p.proconfig)
        AND has_function_privilege('athlya_app', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('athlya_cron', p.oid, 'EXECUTE')
       FROM pg_proc p
      WHERE p.oid = 'reservation_lock_class_for_booking(uuid)'::regprocedure),
    'reservation_lock_class_for_booking: SECURITY DEFINER, athlya_owner, pinned search_path, athlya_app only'
);

SELECT ok(
    (SELECT p.prosecdef
        AND pg_get_userbyid(p.proowner) = 'athlya_owner'
        AND 'search_path=public, pg_temp' = ANY (p.proconfig)
        AND has_function_privilege('athlya_cron', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('athlya_app', p.oid, 'EXECUTE')
       FROM pg_proc p
      WHERE p.oid = 'reservation_sweep_holds_and_promote(integer)'::regprocedure),
    'reservation_sweep_holds_and_promote: SECURITY DEFINER, athlya_owner, pinned search_path, athlya_cron only'
);

SELECT ok(
    NOT has_table_privilege('athlya_cron', 'reservations', 'SELECT')
    AND NOT has_table_privilege('athlya_cron', 'classes', 'SELECT')
    AND NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'athlya_cron'),
    'athlya_cron still holds no grant on reservations or classes and no BYPASSRLS'
);

-- ---------- seed (migration superuser) ----------
-- H: capacity 2, upcoming. S: started an hour ago. E: capacity 1, with
-- an expired hold of member A2 and two waiters (coach A oldest).

INSERT INTO classes (id, studio_id, title, starts_at, duration_min, capacity, version) VALUES
    ('cccccccc-cccc-4ccc-8ccc-cccccccc0501', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Holds H',   '2030-09-01 09:00:00+00', 60, 2, 0),
    ('cccccccc-cccc-4ccc-8ccc-cccccccc0502', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Started S', now() - interval '1 hour', 90, 5, 0),
    ('cccccccc-cccc-4ccc-8ccc-cccccccc0503', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Sweep E',   '2030-09-02 09:00:00+00', 60, 1, 0);

SET LOCAL session_replication_role = replica;
INSERT INTO reservations (id, class_id, user_id, status, hold_expires_at, created_at) VALUES
    ('dddddddd-dddd-4ddd-8ddd-dddddddd0531', 'cccccccc-cccc-4ccc-8ccc-cccccccc0503', '11111111-1111-4111-8111-111111111112', 'pending',  now() - interval '1 minute', '2026-03-01 00:00:00+00'),
    ('dddddddd-dddd-4ddd-8ddd-dddddddd0532', 'cccccccc-cccc-4ccc-8ccc-cccccccc0503', '11111111-1111-4111-8111-111111111114', 'waitlist', NULL,                         '2026-03-02 00:00:00+00'),
    ('dddddddd-dddd-4ddd-8ddd-dddddddd0533', 'cccccccc-cccc-4ccc-8ccc-cccccccc0503', '11111111-1111-4111-8111-111111111111', 'waitlist', NULL,                         '2026-03-03 00:00:00+00');
SET LOCAL session_replication_role = origin;

-- ---------- holds under athlya_app ----------

SET LOCAL ROLE athlya_app;
SELECT test_set_tenant('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member');

SELECT throws_ok(
    $$ INSERT INTO reservations (class_id, user_id, status)
       VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccc0501', '11111111-1111-4111-8111-111111111111', 'pending') $$,
    'P0001', 'hold_expiry_out_of_range',
    'a hold without an expiry is refused'
);

SELECT throws_ok(
    $$ INSERT INTO reservations (class_id, user_id, status, hold_expires_at)
       VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccc0501', '11111111-1111-4111-8111-111111111111', 'pending', now() + interval '2 hours') $$,
    'P0001', 'hold_expiry_out_of_range',
    'a hold longer than 30 minutes is refused'
);

SELECT lives_ok(
    $$ INSERT INTO reservations (id, class_id, user_id, status, hold_expires_at)
       VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddd0511', 'cccccccc-cccc-4ccc-8ccc-cccccccc0501',
               '11111111-1111-4111-8111-111111111111', 'pending', now() + interval '10 minutes') $$,
    'member A holds a seat on H for 10 minutes'
);

SELECT throws_ok(
    $$ INSERT INTO reservations (class_id, user_id, status, hold_expires_at)
       VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccc0501', '11111111-1111-4111-8111-111111111111', 'pending', now() + interval '5 minutes') $$,
    '23505', NULL,
    'a second live row for the same member and class is refused (live unique index)'
);

SELECT throws_ok(
    $$ UPDATE reservations SET hold_expires_at = now() + interval '20 minutes'
        WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddd0511' $$,
    'P0001', 'hold_extension_refused',
    'a hold cannot be extended'
);

SELECT test_set_tenant('11111111-1111-4111-8111-111111111112', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member');

SELECT lives_ok(
    $$ INSERT INTO reservations (id, class_id, user_id, status, hold_expires_at)
       VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddd0512', 'cccccccc-cccc-4ccc-8ccc-cccccccc0501',
               '11111111-1111-4111-8111-111111111112', 'confirmed', now() + interval '5 minutes') $$,
    'member A2 books the second seat of H without a hold (current clients unchanged)'
);

SELECT test_set_tenant('11111111-1111-4111-8111-111111111114', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'coach');

SELECT throws_ok(
    $$ INSERT INTO reservations (class_id, user_id, status, hold_expires_at)
       VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccc0501', '11111111-1111-4111-8111-111111111114', 'pending', now() + interval '10 minutes') $$,
    'P0001', 'class_capacity_exceeded',
    'a hold on a class full of one confirmed row and one active hold is refused'
);

SELECT throws_ok(
    $$ INSERT INTO reservations (class_id, user_id, status)
       VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccc0501', '11111111-1111-4111-8111-111111111114', 'confirmed') $$,
    'P0001', 'class_capacity_exceeded',
    'an active hold takes a seat for a confirmed booking too'
);

SELECT lives_ok(
    $$ INSERT INTO reservations (id, class_id, user_id, status, created_at)
       VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddd0513', 'cccccccc-cccc-4ccc-8ccc-cccccccc0501',
               '11111111-1111-4111-8111-111111111114', 'waitlist', '2026-03-01 00:00:00+00') $$,
    'the waitlist stays open on a class full of holds'
);

SELECT test_set_tenant('11111111-1111-4111-8111-111111111112', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member');

SELECT is(
    (SELECT outcome FROM reservation_promote_oldest_waitlist('cccccccc-cccc-4ccc-8ccc-cccccccc0501')),
    'no_capacity',
    'reservation_promote_oldest_waitlist: an active hold keeps the seat from the waiter'
);

RESET ROLE;

SELECT is(
    (SELECT hold_expires_at FROM reservations WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddd0512'),
    NULL::timestamptz,
    'a confirmed row never keeps a hold expiry'
);

SET LOCAL ROLE athlya_cron;

SELECT is(
    (SELECT confirmed FROM capacity_reconcile_snapshot() WHERE class_id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0501'),
    2,
    'capacity_reconcile_snapshot: the occupied count includes the active hold'
);

SELECT is(
    (SELECT confirmed FROM capacity_reconcile_snapshot() WHERE class_id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0503'),
    0,
    'capacity_reconcile_snapshot: an expired hold no longer counts'
);

RESET ROLE;
SET LOCAL ROLE athlya_app;
SELECT test_set_tenant('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member');

SELECT lives_ok(
    $$ UPDATE reservations SET status = 'confirmed' WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddd0511' $$,
    'member A confirms the active hold on the full class (its seat was already counted)'
);

RESET ROLE;

SELECT results_eq(
    $$ SELECT status::text, hold_expires_at FROM reservations WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddd0511' $$,
    $$ VALUES ('confirmed'::text, NULL::timestamptz) $$,
    'the confirmed hold is an ordinary confirmed row, expiry cleared'
);

SET LOCAL ROLE athlya_app;
SELECT test_set_tenant('11111111-1111-4111-8111-111111111112', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member');

SELECT throws_ok(
    $$ UPDATE reservations SET status = 'confirmed' WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddd0531' $$,
    'P0001', 'hold_expired',
    'an expired hold cannot be confirmed'
);

SELECT throws_ok(
    $$ UPDATE reservations SET status = 'pending', hold_expires_at = now() + interval '5 minutes'
        WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddd0512' $$,
    'P0001', 'hold_not_reopenable',
    'a confirmed row cannot turn back into a hold'
);

-- ---------- version fencing for bookings ----------

SELECT results_eq(
    $$ SELECT starts_at, version FROM reservation_lock_class_for_booking('cccccccc-cccc-4ccc-8ccc-cccccccc0501') $$,
    $$ VALUES ('2030-09-01 09:00:00+00'::timestamptz, 0) $$,
    'reservation_lock_class_for_booking: start time and version of a class of the caller''s studio'
);

SELECT is_empty(
    $$ SELECT 1 FROM reservation_lock_class_for_booking('cccccccc-cccc-4ccc-8ccc-cccccccccccb') $$,
    'reservation_lock_class_for_booking: empty for another studio''s class'
);

SELECT throws_ok(
    $$ SELECT * FROM reservation_sweep_holds_and_promote(10) $$,
    '42501', NULL,
    'athlya_app cannot execute the cron sweep'
);

-- ---------- classes guard (admin A) ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111113', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin');

SELECT throws_ok(
    $$ UPDATE classes SET capacity = 1, version = version + 1
        WHERE id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0501' $$,
    'P0001', 'class_capacity_below_booked',
    'capacity cannot go below the confirmed rows'
);

SELECT throws_ok(
    $$ UPDATE classes SET capacity = 3 WHERE id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0501' $$,
    'P0001', 'class_version_not_bumped',
    'a capacity change must bump version'
);

SELECT throws_ok(
    $$ UPDATE classes SET starts_at = '2030-09-01 10:00:00+00', version = 0
        WHERE id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0501' $$,
    'P0001', 'class_version_not_bumped',
    'a start time change must bump version'
);

SELECT throws_ok(
    $$ UPDATE classes SET starts_at = now() - interval '1 day', version = version + 1
        WHERE id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0501' $$,
    'P0001', 'class_starts_in_past',
    'a class cannot be moved into the past'
);

SELECT throws_ok(
    $$ UPDATE classes SET starts_at = now() + interval '1 day', version = version + 1
        WHERE id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0502' $$,
    'P0001', 'class_already_started',
    'a class that already started cannot be moved'
);

SELECT lives_ok(
    $$ UPDATE classes SET title = 'Started S renamed' WHERE id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0502' $$,
    'other columns of a started class stay editable'
);

SELECT lives_ok(
    $$ UPDATE classes SET capacity = 3, starts_at = '2030-09-01 10:00:00+00', version = version + 1
        WHERE id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0501' $$,
    'a fenced capacity and start change goes through'
);

SELECT lives_ok(
    $$ UPDATE classes SET capacity = 2, version = version + 1
        WHERE id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0501' $$,
    'capacity can come back down to exactly the confirmed rows'
);

SELECT test_set_tenant('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member');

SELECT is(
    (SELECT version FROM reservation_lock_class_for_booking('cccccccc-cccc-4ccc-8ccc-cccccccc0501')),
    2,
    'reservation_lock_class_for_booking: a member sees the bumped version'
);

-- ---------- cron sweep (athlya_cron) ----------

RESET ROLE;
SET LOCAL ROLE athlya_cron;

SELECT throws_ok(
    $$ SELECT 1 FROM reservations LIMIT 1 $$,
    '42501', NULL,
    'athlya_cron cannot read reservations directly'
);

SELECT ok(
    (SELECT expired_holds >= 1 AND promoted_waiters >= 1 AND promoted_classes >= 1
       FROM reservation_sweep_holds_and_promote(100)),
    'the sweep expires holds and promotes waiters'
);

RESET ROLE;

SELECT results_eq(
    $$ SELECT status::text, hold_expires_at, cancelled_at IS NOT NULL
         FROM reservations WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddd0531' $$,
    $$ VALUES ('cancelled'::text, NULL::timestamptz, true) $$,
    'the expired hold is cancelled, expiry cleared'
);

SELECT results_eq(
    $$ SELECT id::text, status::text FROM reservations
        WHERE class_id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0503' AND status IN ('confirmed', 'waitlist')
        ORDER BY created_at $$,
    $$ VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddd0532'::text, 'confirmed'::text),
              ('dddddddd-dddd-4ddd-8ddd-dddddddd0533'::text, 'waitlist'::text) $$,
    'the oldest waiter takes the freed seat; the next one keeps waiting'
);

SELECT results_eq(
    $$ SELECT studio_id::text, payload->>'reservationId', payload->>'userId', payload->>'classId'
         FROM outbox
        WHERE event_type = 'reservation.promoted'
          AND payload->>'reservationId' = 'dddddddd-dddd-4ddd-8ddd-dddddddd0532' $$,
    $$ VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::text,
               'dddddddd-dddd-4ddd-8ddd-dddddddd0532'::text,
               '11111111-1111-4111-8111-111111111114'::text,
               'cccccccc-cccc-4ccc-8ccc-cccccccc0503'::text) $$,
    'the promotion writes one reservation.promoted outbox row for the class studio'
);

SELECT is(
    (SELECT count(*)::int FROM reservations
      WHERE class_id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0501' AND status = 'confirmed'),
    2,
    'the sweep leaves a full class alone'
);

SET LOCAL ROLE athlya_cron;

SELECT ok(
    (SELECT expired_holds = 0 AND promoted_waiters = 0
       FROM reservation_sweep_holds_and_promote(100)),
    'a second sweep has nothing left to do'
);

SELECT throws_ok(
    $$ SELECT * FROM reservation_sweep_holds_and_promote(0) $$,
    '22023', NULL,
    'the sweep refuses a non-positive limit'
);

RESET ROLE;

SELECT throws_ok(
    $$ UPDATE reservations SET status = 'pending', hold_expires_at = now() + interval '5 minutes'
        WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddd0531' $$,
    'P0001', 'hold_not_reopenable',
    'a cancelled hold cannot be reopened, even by the migration superuser'
);

SELECT ok(
    (SELECT tgenabled = 'O' FROM pg_trigger
      WHERE tgname = 'classes_guard_schedule' AND tgrelid = 'classes'::regclass),
    'classes_guard_schedule is installed and enabled'
);

SELECT finish();
ROLLBACK;
