-- =====================================================================
-- constraints.sql — CHECK constraint violations (migration 0024)
--
-- Covered constraints (Issue #421):
--   - classes_capacity_positive     capacity > 0
--   - classes_capacity_max          capacity <= 10000
--   - classes_duration_min_positive duration_min > 0
--   - classes_duration_min_max      duration_min <= 1440
--   - workout_sessions_duration_min_positive  duration_min IS NULL OR > 0
--
-- These are tested as the superuser (no role switch needed) because
-- CHECK constraints fire at the storage layer, independently of RLS.
-- All inserts are rolled back at the end.
-- =====================================================================

BEGIN;

SELECT plan(7);

-- Valid insert must succeed (baseline).
SELECT lives_ok(
    $$INSERT INTO "classes" (id, studio_id, title, starts_at, duration_min, capacity)
      VALUES (
        'dddddddd-dddd-4ddd-8ddd-dddddddddd01',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'Constraint test class',
        '2030-06-01 09:00:00+00',
        60,
        20
      )$$,
    'classes: valid (duration_min=60, capacity=20) inserts cleanly'
);

-- capacity = 0 must fail.
SELECT throws_ok(
    $$INSERT INTO "classes" (id, studio_id, title, starts_at, duration_min, capacity)
      VALUES (
        'dddddddd-dddd-4ddd-8ddd-dddddddddd02',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'Bad capacity zero',
        '2030-06-01 09:00:00+00',
        60,
        0
      )$$,
    '23514',
    NULL,
    'classes: capacity = 0 violates classes_capacity_positive (23514)'
);

-- capacity < 0 must fail.
SELECT throws_ok(
    $$INSERT INTO "classes" (id, studio_id, title, starts_at, duration_min, capacity)
      VALUES (
        'dddddddd-dddd-4ddd-8ddd-dddddddddd03',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'Bad capacity negative',
        '2030-06-01 09:00:00+00',
        60,
        -1
      )$$,
    '23514',
    NULL,
    'classes: capacity < 0 violates classes_capacity_positive (23514)'
);

-- capacity > 10000 must fail.
SELECT throws_ok(
    $$INSERT INTO "classes" (id, studio_id, title, starts_at, duration_min, capacity)
      VALUES (
        'dddddddd-dddd-4ddd-8ddd-dddddddddd04',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'Bad capacity huge',
        '2030-06-01 09:00:00+00',
        60,
        10001
      )$$,
    '23514',
    NULL,
    'classes: capacity > 10000 violates classes_capacity_max (23514)'
);

-- duration_min = 0 must fail.
SELECT throws_ok(
    $$INSERT INTO "classes" (id, studio_id, title, starts_at, duration_min, capacity)
      VALUES (
        'dddddddd-dddd-4ddd-8ddd-dddddddddd05',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'Bad duration zero',
        '2030-06-01 09:00:00+00',
        0,
        10
      )$$,
    '23514',
    NULL,
    'classes: duration_min = 0 violates classes_duration_min_positive (23514)'
);

-- duration_min > 1440 must fail.
SELECT throws_ok(
    $$INSERT INTO "classes" (id, studio_id, title, starts_at, duration_min, capacity)
      VALUES (
        'dddddddd-dddd-4ddd-8ddd-dddddddddd06',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'Bad duration too long',
        '2030-06-01 09:00:00+00',
        1441,
        10
      )$$,
    '23514',
    NULL,
    'classes: duration_min > 1440 violates classes_duration_min_max (23514)'
);

-- workout_sessions: duration_min = 0 must fail (NULL is allowed).
SELECT throws_ok(
    $$INSERT INTO "workout_sessions" (id, user_id, studio_id, started_at, duration_min, exercises)
      VALUES (
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01',
        '11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '2030-06-01 09:00:00+00',
        0,
        '[]'::jsonb
      )$$,
    '23514',
    NULL,
    'workout_sessions: duration_min = 0 violates workout_sessions_duration_min_positive (23514)'
);

SELECT * FROM finish();
ROLLBACK;
