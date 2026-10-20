-- =====================================================================
-- workout_sessions_external_source.sql — migration 0048 (issue #688)
--
-- Imported sessions carry their source app and the workout id there.
-- Both columns are nullable with no default (expand only); the partial
-- unique index allows one session per (user, source, external_id); the
-- CHECKs refuse an unknown source, half a pair and an out-of-range id;
-- the owner-only policies of 0001 keep the columns private. The RGPD
-- export (`export_job_rows`, 0049) adds `source` and `externalId` to an
-- imported session only.
-- =====================================================================

BEGIN;
SELECT plan(21);

SELECT col_is_null('public', 'workout_sessions', 'source',
    'workout_sessions.source is nullable (expand only)');
SELECT col_hasnt_default('public', 'workout_sessions', 'source',
    'workout_sessions.source has no default');
SELECT col_is_null('public', 'workout_sessions', 'external_id',
    'workout_sessions.external_id is nullable (expand only)');
SELECT col_hasnt_default('public', 'workout_sessions', 'external_id',
    'workout_sessions.external_id has no default');
SELECT ok(
    (SELECT indisunique FROM pg_index
      WHERE indexrelid = 'public.workout_sessions_user_source_external_id_uniq'::regclass),
    'workout_sessions_user_source_external_id_uniq is a unique index'
);

SET LOCAL ROLE athlya_tenant_test;

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

SELECT lives_ok(
    $$INSERT INTO "workout_sessions" (user_id, started_at, exercises)
      VALUES ('11111111-1111-4111-8111-111111111111', '2026-04-01 08:00:00+00', '[]'::jsonb)$$,
    'workout_sessions: an old-Worker insert without a source still works'
);

SELECT lives_ok(
    $$INSERT INTO "workout_sessions" (user_id, started_at, exercises, source, external_id)
      VALUES ('11111111-1111-4111-8111-111111111111', '2026-04-02 08:00:00+00', '[]'::jsonb,
              'appleHealth', 'HK-0047-1')$$,
    'workout_sessions: an imported session stores its source and external id'
);

SELECT throws_ok(
    $$INSERT INTO "workout_sessions" (user_id, started_at, exercises, source, external_id)
      VALUES ('11111111-1111-4111-8111-111111111111', '2026-04-03 08:00:00+00', '[]'::jsonb,
              'appleHealth', 'HK-0047-1')$$,
    '23505',
    NULL,
    'workout_sessions: the same workout cannot be imported twice by one user'
);

SELECT is_empty(
    $$INSERT INTO "workout_sessions" (user_id, started_at, exercises, source, external_id)
      VALUES ('11111111-1111-4111-8111-111111111111', '2026-04-03 08:00:00+00', '[]'::jsonb,
              'appleHealth', 'HK-0047-1')
      ON CONFLICT DO NOTHING
      RETURNING id$$,
    'workout_sessions: a re-import with ON CONFLICT DO NOTHING inserts nothing'
);

SELECT throws_ok(
    $$INSERT INTO "workout_sessions" (user_id, started_at, exercises, source, external_id)
      VALUES ('11111111-1111-4111-8111-111111111111', '2026-04-04 08:00:00+00', '[]'::jsonb,
              'garmin', 'G-1')$$,
    '23514',
    NULL,
    'workout_sessions: an unknown source is refused'
);

SELECT throws_ok(
    $$INSERT INTO "workout_sessions" (user_id, started_at, exercises, source)
      VALUES ('11111111-1111-4111-8111-111111111111', '2026-04-04 08:00:00+00', '[]'::jsonb,
              'appleHealth')$$,
    '23514',
    NULL,
    'workout_sessions: a source without an external id is refused'
);

SELECT throws_ok(
    $$INSERT INTO "workout_sessions" (user_id, started_at, exercises, external_id)
      VALUES ('11111111-1111-4111-8111-111111111111', '2026-04-04 08:00:00+00', '[]'::jsonb,
              'HK-0047-2')$$,
    '23514',
    NULL,
    'workout_sessions: an external id without a source is refused'
);

SELECT throws_ok(
    $$INSERT INTO "workout_sessions" (user_id, started_at, exercises, source, external_id)
      VALUES ('11111111-1111-4111-8111-111111111111', '2026-04-04 08:00:00+00', '[]'::jsonb,
              'appleHealth', repeat('x', 129))$$,
    '23514',
    NULL,
    'workout_sessions: an external id over 128 characters is refused'
);

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111112',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

SELECT lives_ok(
    $$INSERT INTO "workout_sessions" (user_id, started_at, exercises, source, external_id)
      VALUES ('11111111-1111-4111-8111-111111111112', '2026-04-02 08:00:00+00', '[]'::jsonb,
              'appleHealth', 'HK-0047-1')$$,
    'workout_sessions: another member may import a workout with the same id'
);

SELECT is(
    (SELECT count(*)::int FROM "workout_sessions" WHERE external_id = 'HK-0047-1'),
    1,
    'workout_sessions: a member only sees their own imported session'
);

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111113',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'admin'
);

SELECT is(
    (SELECT count(*)::int FROM "workout_sessions" WHERE external_id = 'HK-0047-1'),
    0,
    'workout_sessions: a studio admin cannot read imported sessions of members'
);

-- ---------- RGPD export (0049) ----------

RESET ROLE;
INSERT INTO "workout_sessions" (id, user_id, started_at, exercises, source, external_id)
VALUES ('f6900000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
        '2026-04-05 08:00:00+00', '[]'::jsonb, 'appleHealth', 'HK-0049-1'),
       ('f6900000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
        '2026-04-06 08:00:00+00', '[]'::jsonb, NULL, NULL);
INSERT INTO export_jobs (id, user_id, status, requested_at, started_at)
VALUES ('f6900000-0000-4000-8000-0000000000e1', '11111111-1111-4111-8111-111111111111',
        'running', now(), now());
SET LOCAL ROLE athlya_app;
SELECT set_config('app.user_id', '', true);
SELECT set_config('app.studio_id', '', true);
SELECT set_config('app.role', '', true);

SELECT is(
    (SELECT data->>'source'
       FROM export_job_rows('f6900000-0000-4000-8000-0000000000e1', 'workout_sessions', NULL, 500)
      WHERE data->>'id' = 'f6900000-0000-4000-8000-000000000001'),
    'appleHealth',
    'export_job_rows: an imported session exports its source'
);

SELECT is(
    (SELECT data->>'externalId'
       FROM export_job_rows('f6900000-0000-4000-8000-0000000000e1', 'workout_sessions', NULL, 500)
      WHERE data->>'id' = 'f6900000-0000-4000-8000-000000000001'),
    'HK-0049-1',
    'export_job_rows: an imported session exports its external id'
);

SELECT is(
    (SELECT data ?| ARRAY['source', 'externalId']
       FROM export_job_rows('f6900000-0000-4000-8000-0000000000e1', 'workout_sessions', NULL, 500)
      WHERE data->>'id' = 'f6900000-0000-4000-8000-000000000002'),
    false,
    'export_job_rows: a session logged in Athlya keeps the 0046 shape (no source keys)'
);

SELECT is(
    (SELECT count(*)::int
       FROM export_job_rows('f6900000-0000-4000-8000-0000000000e1', 'workout_sessions', NULL, 500)
      WHERE data->>'externalId' = 'HK-0047-1'),
    1,
    'export_job_rows: exports the job user''s import, not another member''s with the same id'
);

RESET ROLE;
SELECT ok(
    (SELECT p.proowner = 'athlya_owner'::regrole
            AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
            AND has_function_privilege('athlya_app', p.oid, 'EXECUTE')
       FROM pg_proc p
      WHERE p.oid = 'public.export_job_rows(uuid, text, text, integer)'::regprocedure),
    'export_job_rows: owned by athlya_owner, not executable by PUBLIC, granted to athlya_app'
);

SELECT * FROM finish();
ROLLBACK;
