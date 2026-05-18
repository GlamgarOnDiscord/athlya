-- =====================================================================
-- workout_sessions.sql — owner-scoped policies
--
-- Covered policies (Req 13.3):
--   - workout_sessions_read_own     SELECT USING user_id = app_user_id()
--   - workout_sessions_insert_own   INSERT WITH CHECK user_id = app_user_id()
--   - workout_sessions_update_own   UPDATE USING+CHECK user_id = app_user_id()
--   - workout_sessions_delete_own   DELETE USING user_id = app_user_id()
--
-- Workout sessions are strictly personal: neither admins nor coaches
-- can read them through RLS. The service worker uses BYPASSRLS.
-- =====================================================================

BEGIN;
-- Switch to the non-superuser test role so RLS policies actually
-- apply. The session role (postgres) is a superuser and therefore
-- bypasses RLS; the enclosing ROLLBACK restores it at file end.
SET LOCAL ROLE athlya_tenant_test;
SELECT plan(10);

-- ---------- workout_sessions_read_own ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111111',  -- member A
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

SELECT is(
    (SELECT count(*)::int FROM "workout_sessions" WHERE user_id = '11111111-1111-4111-8111-111111111111'),
    1,
    'workout_sessions_read_own: member A sees own session'
);

-- Cross-tenant invisible.
SELECT is_empty(
    $$SELECT id FROM "workout_sessions" WHERE user_id = '22222222-2222-4222-8222-222222222221'$$,
    'workout_sessions_read_own: member A does NOT see member B session'
);

-- Even an admin sees zero because the policy is owner-only.
SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111113',  -- admin A
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'admin'
);

SELECT is(
    (SELECT count(*)::int FROM "workout_sessions" WHERE user_id = '11111111-1111-4111-8111-111111111111'),
    0,
    'workout_sessions_read_own: admin A cannot peek at member A session (owner-only policy)'
);

-- ---------- workout_sessions_insert_own ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

SELECT lives_ok(
    $$INSERT INTO "workout_sessions" (user_id, studio_id, started_at, exercises)
      VALUES ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-02-01 08:00:00+00', '[]'::jsonb)$$,
    'workout_sessions_insert_own: member A can INSERT own session'
);

SELECT throws_ok(
    $$INSERT INTO "workout_sessions" (user_id, studio_id, started_at, exercises)
      VALUES ('22222222-2222-4222-8222-222222222221', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2026-02-01 08:00:00+00', '[]'::jsonb)$$,
    '42501',
    NULL,
    'workout_sessions_insert_own: member A cannot INSERT session for member B (SQLSTATE 42501)'
);

-- ---------- workout_sessions_update_own ----------

WITH upd AS (
    UPDATE "workout_sessions" SET notes = 'self-edit'
    WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01'
    RETURNING id
)
SELECT is(count(*)::int, 1, 'workout_sessions_update_own: member A can UPDATE own session') FROM upd;

WITH upd AS (
    UPDATE "workout_sessions" SET notes = 'hacked'
    WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee03'
    RETURNING id
)
SELECT is(count(*)::int, 0, 'workout_sessions_update_own: member A cannot UPDATE cross-tenant session (zero rows)') FROM upd;

-- Setting user_id to another user via UPDATE violates WITH CHECK.
SELECT throws_ok(
    $$UPDATE "workout_sessions" SET user_id = '22222222-2222-4222-8222-222222222221'
      WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01'$$,
    '42501',
    NULL,
    'workout_sessions_update_own: member A cannot re-assign their session to another user (WITH CHECK)'
);

-- ---------- workout_sessions_delete_own ----------

WITH del AS (
    DELETE FROM "workout_sessions"
    WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01'
    RETURNING id
)
SELECT is(count(*)::int, 1, 'workout_sessions_delete_own: member A can DELETE own session') FROM del;

WITH del AS (
    DELETE FROM "workout_sessions"
    WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee03'
    RETURNING id
)
SELECT is(count(*)::int, 0, 'workout_sessions_delete_own: member A cannot DELETE cross-tenant session (zero rows)') FROM del;

-- Even an admin cannot delete someone else's session through RLS.
SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111113',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'admin'
);

WITH del AS (
    DELETE FROM "workout_sessions"
    WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02'
    RETURNING id
)
SELECT is(count(*)::int, 0, 'workout_sessions_delete_own: admin A cannot DELETE member-of-A session (owner-only policy)') FROM del;

SELECT * FROM finish();
ROLLBACK;
