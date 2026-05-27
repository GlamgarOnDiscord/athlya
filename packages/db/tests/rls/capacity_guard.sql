-- =====================================================================
-- capacity_guard.sql — pgTAP assertions for enforce_class_capacity()
--
-- Runs as the session superuser (postgres) so RLS does not mask trigger
-- behaviour. Each assertion lives inside a rolled-back transaction.
-- =====================================================================

BEGIN;
SELECT plan(4);

-- Dedicated class: capacity = 2, no seed reservations.
INSERT INTO classes (id, studio_id, coach_id, title, starts_at, duration_min, capacity, version)
VALUES (
  'cccccccc-cccc-4ccc-8ccc-cccccccc0099',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '11111111-1111-4111-8111-111111111114',
  'Capacity Guard Test',
  '2031-01-01 09:00:00+00',
  60,
  2,
  0
);

SELECT lives_ok(
  $$INSERT INTO reservations (class_id, user_id, status)
    VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccc0099', '11111111-1111-4111-8111-111111111111', 'confirmed')$$,
  'first confirmed insert succeeds'
);

SELECT lives_ok(
  $$INSERT INTO reservations (class_id, user_id, status)
    VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccc0099', '11111111-1111-4111-8111-111111111112', 'confirmed')$$,
  'second confirmed insert succeeds at capacity'
);

SELECT throws_ok(
  $$INSERT INTO reservations (class_id, user_id, status)
    VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccc0099', '11111111-1111-4111-8111-111111111113', 'confirmed')$$,
  'P0001',
  'third confirmed insert rejected when class is full'
);

SELECT lives_ok(
  $$INSERT INTO reservations (class_id, user_id, status)
    VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccc0099', '11111111-1111-4111-8111-111111111113', 'waitlist')$$,
  'waitlist insert allowed when class is full'
);

SELECT finish();
ROLLBACK;
