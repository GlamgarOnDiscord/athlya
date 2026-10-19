-- =====================================================================
-- workout_sessions_cardio.sql — migration 0046 (issue #667)
--
-- `cardio` is a nullable jsonb column guarded by a CHECK that keeps it a
-- JSON object. It lives on the same row as the session, so the
-- owner-only policies of 0001 cover it unchanged, and the RGPD export
-- (`export_job_rows`) adds it only to the sessions that have one.
-- =====================================================================

BEGIN;
SELECT plan(16);

-- ---------- structure ----------

SELECT has_column('public', 'workout_sessions', 'cardio', 'workout_sessions.cardio exists');
SELECT col_type_is('public', 'workout_sessions', 'cardio', 'jsonb', 'workout_sessions.cardio is jsonb');
SELECT col_is_null('public', 'workout_sessions', 'cardio', 'workout_sessions.cardio is nullable (expand only)');
SELECT col_hasnt_default('public', 'workout_sessions', 'cardio', 'workout_sessions.cardio has no default');

-- ---------- writes under RLS ----------

SET LOCAL ROLE athlya_tenant_test;

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

SELECT lives_ok(
    $$INSERT INTO "workout_sessions" (id, user_id, started_at, exercises, cardio)
      VALUES ('f6670000-0000-7000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
              '2026-03-01 08:00:00+00', '[]'::jsonb,
              '{"machine":"rower","distanceM":5000,"avgPowerW":180}'::jsonb)$$,
    'workout_sessions: a member logs a session with a cardio object'
);

SELECT is(
    (SELECT jsonb_typeof(cardio) FROM "workout_sessions" WHERE id = 'f6670000-0000-7000-8000-000000000001'),
    'object',
    'workout_sessions: cardio is stored as a jsonb object'
);

SELECT is(
    (SELECT (cardio->>'distanceM')::int FROM "workout_sessions" WHERE id = 'f6670000-0000-7000-8000-000000000001'),
    5000,
    'workout_sessions: cardio metrics are queryable'
);

SELECT lives_ok(
    $$INSERT INTO "workout_sessions" (id, user_id, started_at, exercises)
      VALUES ('f6670000-0000-7000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
              '2026-03-01 09:00:00+00', '[]'::jsonb)$$,
    'workout_sessions: an insert without cardio (old Worker) still works'
);

SELECT throws_ok(
    $$INSERT INTO "workout_sessions" (user_id, started_at, exercises, cardio)
      VALUES ('11111111-1111-4111-8111-111111111111', '2026-03-01 10:00:00+00', '[]'::jsonb,
              to_jsonb('{"machine":"rower"}'::text))$$,
    '23514',
    NULL,
    'workout_sessions_cardio_object: a double-encoded jsonb string is refused'
);

SELECT throws_ok(
    $$INSERT INTO "workout_sessions" (user_id, started_at, exercises, cardio)
      VALUES ('11111111-1111-4111-8111-111111111111', '2026-03-01 10:00:00+00', '[]'::jsonb,
              '[{"distanceM":5000}]'::jsonb)$$,
    '23514',
    NULL,
    'workout_sessions_cardio_object: an array is refused'
);

-- ---------- reads under RLS: owner only ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111112',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

SELECT is_empty(
    $$SELECT cardio FROM "workout_sessions" WHERE id = 'f6670000-0000-7000-8000-000000000001'$$,
    'workout_sessions_read_own: another member cannot read the cardio summary'
);

SELECT is_empty(
    $$UPDATE "workout_sessions" SET cardio = '{}'::jsonb
       WHERE id = 'f6670000-0000-7000-8000-000000000001' RETURNING id$$,
    'workout_sessions_update_own: another member cannot overwrite the cardio summary'
);

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111113',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'admin'
);

SELECT is_empty(
    $$SELECT cardio FROM "workout_sessions" WHERE id = 'f6670000-0000-7000-8000-000000000001'$$,
    'workout_sessions_read_own: a studio admin cannot read the cardio summary either'
);

-- ---------- RGPD export ----------

RESET ROLE;
INSERT INTO export_jobs (id, user_id, status, requested_at, started_at)
VALUES ('f6670000-0000-7000-8000-0000000000e1', '11111111-1111-4111-8111-111111111111',
        'running', now(), now());
SET LOCAL ROLE athlya_app;
SELECT set_config('app.user_id', '', true);
SELECT set_config('app.studio_id', '', true);
SELECT set_config('app.role', '', true);

SELECT is(
    (SELECT data->'cardio'
       FROM export_job_rows('f6670000-0000-7000-8000-0000000000e1', 'workout_sessions', NULL, 500)
      WHERE data->>'id' = 'f6670000-0000-7000-8000-000000000001'),
    '{"machine":"rower","distanceM":5000,"avgPowerW":180}'::jsonb,
    'export_job_rows: a session with a cardio summary exports it'
);

SELECT is(
    (SELECT data ? 'cardio'
       FROM export_job_rows('f6670000-0000-7000-8000-0000000000e1', 'workout_sessions', NULL, 500)
      WHERE data->>'id' = 'f6670000-0000-7000-8000-000000000002'),
    false,
    'export_job_rows: a session without one keeps the 0034 shape (no cardio key)'
);

SELECT is(
    (SELECT count(*)::int
       FROM export_job_rows('f6670000-0000-7000-8000-0000000000e1', 'workout_sessions', NULL, 500)),
    3,
    'export_job_rows: still only the job user''s sessions (seed + two new)'
);

SELECT * FROM finish();
ROLLBACK;
