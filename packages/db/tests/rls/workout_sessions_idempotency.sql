-- =====================================================================
-- workout_sessions_idempotency.sql — migration 0044 (issue #652)
--
-- The request key is stored with the session; the partial unique index
-- on (user_id, idempotency_key) allows one row per key and user, any
-- number of rows without a key, and the same key for two users.
-- =====================================================================

BEGIN;
SET LOCAL ROLE athlya_tenant_test;
SELECT plan(5);

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

SELECT lives_ok(
    $$INSERT INTO "workout_sessions" (user_id, started_at, exercises, idempotency_key)
      VALUES ('11111111-1111-4111-8111-111111111111', '2026-03-01 08:00:00+00', '[]'::jsonb, 'key-0044')$$,
    'workout_sessions: a session can carry its request idempotency key'
);

SELECT throws_ok(
    $$INSERT INTO "workout_sessions" (user_id, started_at, exercises, idempotency_key)
      VALUES ('11111111-1111-4111-8111-111111111111', '2026-03-01 09:00:00+00', '[]'::jsonb, 'key-0044')$$,
    '23505',
    NULL,
    'workout_sessions: a second session with the same (user, key) is refused'
);

SELECT lives_ok(
    $$INSERT INTO "workout_sessions" (user_id, started_at, exercises)
      VALUES ('11111111-1111-4111-8111-111111111111', '2026-03-02 08:00:00+00', '[]'::jsonb),
             ('11111111-1111-4111-8111-111111111111', '2026-03-02 08:00:00+00', '[]'::jsonb)$$,
    'workout_sessions: rows without a key stay outside the partial unique index'
);

SELECT is_empty(
    $$INSERT INTO "workout_sessions" (user_id, started_at, exercises, idempotency_key)
      VALUES ('11111111-1111-4111-8111-111111111111', '2026-03-03 08:00:00+00', '[]'::jsonb, 'key-0044')
      ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING id$$,
    'workout_sessions: ON CONFLICT DO NOTHING on the key inserts nothing'
);

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111112',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

SELECT lives_ok(
    $$INSERT INTO "workout_sessions" (user_id, started_at, exercises, idempotency_key)
      VALUES ('11111111-1111-4111-8111-111111111112', '2026-03-01 08:00:00+00', '[]'::jsonb, 'key-0044')$$,
    'workout_sessions: another member may use the same key'
);

SELECT * FROM finish();
ROLLBACK;
