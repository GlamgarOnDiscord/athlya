-- =====================================================================
-- export_runtime.sql — RGPD export under athlya_app (issue #498)
--
-- Producer: export_jobs_insert_own + outbox_insert_tenant let a member
-- enqueue only their own pending job and its event, in one statement.
-- Worker: the 0034 functions run as athlya_app WITHOUT tenant claims
-- (queue consumer posture); data is readable only for a claimed job,
-- and only the current claim token can complete or fail it.
--
-- Claim tokens are read back as the superuser and stashed in a
-- transaction-local `test.*` setting, since athlya_app cannot see the row.
-- =====================================================================

BEGIN;
SELECT plan(25);

SET LOCAL ROLE athlya_app;

-- ---------- producer: member enqueues their own export ----------

SELECT set_config('app.user_id', '11111111-1111-4111-8111-111111111111', true);
SELECT set_config('app.studio_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
SELECT set_config('app.role', 'member', true);

SELECT lives_ok(
    $$ WITH job AS (
           INSERT INTO export_jobs (id, user_id, status, requested_at)
           VALUES ('e4980000-0000-7000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'pending', now())
           RETURNING id
       )
       INSERT INTO outbox (event_id, event_type, payload, occurred_at)
       SELECT 'evt-498-requested', 'members.export.requested', '{}'::jsonb, now() FROM job $$,
    'export_jobs_insert_own: member enqueues own pending job + outbox event in one statement'
);

SELECT throws_ok(
    $$ INSERT INTO export_jobs (id, user_id, status) VALUES
       ('e4980000-0000-7000-8000-000000000002', '11111111-1111-4111-8111-111111111112', 'pending') $$,
    '42501',
    NULL,
    'export_jobs_insert_own: cannot enqueue for another user'
);

SELECT throws_ok(
    $$ INSERT INTO export_jobs (id, user_id, status, download_url) VALUES
       ('e4980000-0000-7000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'completed', 'https://evil') $$,
    '42501',
    NULL,
    'export_jobs_insert_own: cannot insert a completed job with a forged URL'
);

SELECT throws_ok(
    $$ INSERT INTO export_jobs (id, user_id, status, claim_token) VALUES
       ('e4980000-0000-7000-8000-000000000005', '11111111-1111-4111-8111-111111111111', 'pending',
        'e4980000-0000-7000-8000-0000000000aa') $$,
    '42501',
    NULL,
    'export_jobs_insert_own: cannot insert a pre-set claim token'
);

SELECT is(
    (SELECT count(*)::int FROM export_jobs WHERE id = 'e4980000-0000-7000-8000-000000000001'),
    1,
    'export_jobs_read_own: member reads their job back'
);

-- ---------- worker: no tenant claims ----------

SELECT set_config('app.user_id', '', true);
SELECT set_config('app.studio_id', '', true);
SELECT set_config('app.role', '', true);

SELECT is(
    (SELECT count(*)::int FROM export_jobs),
    0,
    'without claims the raw table is invisible to athlya_app'
);

SELECT is(
    (SELECT status FROM export_job_get('e4980000-0000-7000-8000-000000000001')),
    'pending',
    'export_job_get: worker reads the job by id'
);

SELECT is(
    export_job_profile('e4980000-0000-7000-8000-000000000001'),
    NULL,
    'export_job_profile: no data before the job is claimed'
);

SELECT is_empty(
    $$ SELECT * FROM export_job_rows('e4980000-0000-7000-8000-000000000001', 'reservations', NULL, 100) $$,
    'export_job_rows: no data before the job is claimed'
);

SELECT isnt(
    export_job_claim('e4980000-0000-7000-8000-000000000001'),
    NULL,
    'export_job_claim: first delivery wins the claim and gets a token'
);

SELECT is(
    export_job_claim('e4980000-0000-7000-8000-000000000001'),
    NULL,
    'export_job_claim: a second claim is refused while the lease is fresh'
);

RESET ROLE;
SELECT set_config('test.tok1', claim_token::text, true)
  FROM export_jobs WHERE id = 'e4980000-0000-7000-8000-000000000001';
INSERT INTO audit_log (actor_id, action, target_type, target_id, metadata) VALUES
    ('11111111-1111-4111-8111-111111111113', 'test.export.subject', 'user',
     '11111111-1111-4111-8111-111111111111',
     '{"subjectUserId":"11111111-1111-4111-8111-111111111111","eventType":"user.updated",
       "email":"admin@athlya.test","displayName":"Admin","note":"by admin@athlya.test"}'::jsonb);
SET LOCAL ROLE athlya_app;

SELECT is(
    export_job_profile('e4980000-0000-7000-8000-000000000001')->>'email',
    'member-a@athlya.test',
    'export_job_profile: profile of the job user once claimed'
);

SELECT results_eq(
    $$ SELECT data->>'id' FROM export_job_rows('e4980000-0000-7000-8000-000000000001', 'reservations', NULL, 100) $$,
    $$ VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddd01'::text) $$,
    'export_job_rows: only the job user''s reservations'
);

SELECT results_eq(
    $$ SELECT data->>'id' FROM export_job_rows('e4980000-0000-7000-8000-000000000001', 'workout_sessions', NULL, 100) $$,
    $$ VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01'::text) $$,
    'export_job_rows: only the job user''s workout sessions'
);

SELECT is_empty(
    $$ SELECT * FROM export_job_rows('e4980000-0000-7000-8000-000000000001', 'reservations',
                                     'dddddddd-dddd-4ddd-8ddd-dddddddddd01', 100) $$,
    'export_job_rows: keyset cursor pages past the last row'
);

SELECT results_eq(
    $$ SELECT data->'actorId', data->'metadata'
         FROM export_job_rows('e4980000-0000-7000-8000-000000000001', 'audit_trail', NULL, 500)
        WHERE data->>'action' = 'test.export.subject' $$,
    $$ VALUES ('null'::jsonb,
               '{"subjectUserId":"11111111-1111-4111-8111-111111111111","eventType":"user.updated"}'::jsonb) $$,
    'export_job_rows: audit rows by another actor keep only allow-listed metadata, no actor'
);

SELECT throws_ok(
    $$ SELECT * FROM export_job_rows('e4980000-0000-7000-8000-000000000001', 'users', NULL, 100) $$,
    '22023',
    NULL,
    'export_job_rows: unknown section is refused'
);

SELECT ok(
    NOT export_job_complete('e4980000-0000-7000-8000-000000000001', gen_random_uuid(),
                            'https://evil', now() + interval '72 hours'),
    'export_job_complete: a token other than the current claim is refused'
);

SELECT ok(
    export_job_complete('e4980000-0000-7000-8000-000000000001', current_setting('test.tok1')::uuid,
                        'https://api/download', now() + interval '72 hours')
    AND NOT export_job_complete('e4980000-0000-7000-8000-000000000001', current_setting('test.tok1')::uuid,
                                'https://api/again', now()),
    'export_job_complete: exactly one completion transition'
);

SELECT is(
    export_job_profile('e4980000-0000-7000-8000-000000000001'),
    NULL,
    'export_job_profile: data is no longer readable once the job is completed'
);

-- ---------- lease expiry ----------

RESET ROLE;
INSERT INTO export_jobs (id, user_id, status, started_at, claim_token) VALUES
    ('e4980000-0000-7000-8000-000000000004', '11111111-1111-4111-8111-111111111112', 'running',
     now() - interval '20 minutes', 'e4980000-0000-7000-8000-00000000057a');
SET LOCAL ROLE athlya_app;

SELECT isnt(
    export_job_claim('e4980000-0000-7000-8000-000000000004'),
    NULL,
    'export_job_claim: a running job with an expired lease is reclaimed'
);

SELECT ok(
    NOT export_job_complete('e4980000-0000-7000-8000-000000000004', 'e4980000-0000-7000-8000-00000000057a',
                            'https://stale', now() + interval '72 hours')
    AND NOT export_job_fail('e4980000-0000-7000-8000-000000000004', 'e4980000-0000-7000-8000-00000000057a',
                            'stale run'),
    'export_job_complete / export_job_fail: the reclaimed run''s stale token is refused'
);

SELECT is(
    (SELECT status FROM export_job_get('e4980000-0000-7000-8000-000000000004')),
    'running',
    'export_job_claim: the newer run still owns the job after the stale attempts'
);

RESET ROLE;
SELECT set_config('test.tok4', claim_token::text, true)
  FROM export_jobs WHERE id = 'e4980000-0000-7000-8000-000000000004';
SET LOCAL ROLE athlya_app;

SELECT ok(
    export_job_fail('e4980000-0000-7000-8000-000000000004', current_setting('test.tok4')::uuid,
                    repeat('x', 900)),
    'export_job_fail: the current claim fails a running job'
);

SELECT is(
    (SELECT length(error) FROM export_job_get('e4980000-0000-7000-8000-000000000004')),
    500,
    'export_job_fail: the stored reason is bounded'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
