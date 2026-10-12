-- =====================================================================
-- export_runtime.sql — RGPD export under athlya_app (issue #498)
--
-- Producer: export_jobs_insert_own + outbox_insert_tenant let a member
-- enqueue only their own pending job and its event, in one statement.
-- Worker: the 0034 functions run as athlya_app WITHOUT tenant claims
-- (queue consumer posture); data is readable only for a claimed job.
-- =====================================================================

BEGIN;
SELECT plan(20);

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

SELECT ok(
    export_job_claim('e4980000-0000-7000-8000-000000000001'),
    'export_job_claim: first delivery wins the claim'
);

SELECT ok(
    NOT export_job_claim('e4980000-0000-7000-8000-000000000001'),
    'export_job_claim: a concurrent delivery loses while the lease is fresh'
);

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

SELECT throws_ok(
    $$ SELECT * FROM export_job_rows('e4980000-0000-7000-8000-000000000001', 'users', NULL, 100) $$,
    '22023',
    NULL,
    'export_job_rows: unknown section is refused'
);

SELECT ok(
    export_job_complete('e4980000-0000-7000-8000-000000000001', 'https://api/download', now() + interval '72 hours')
    AND NOT export_job_complete('e4980000-0000-7000-8000-000000000001', 'https://api/again', now()),
    'export_job_complete: exactly one completion transition'
);

SELECT is(
    export_job_profile('e4980000-0000-7000-8000-000000000001'),
    NULL,
    'export_job_profile: data is no longer readable once the job is completed'
);

-- ---------- lease expiry ----------

RESET ROLE;
INSERT INTO export_jobs (id, user_id, status, started_at) VALUES
    ('e4980000-0000-7000-8000-000000000004', '11111111-1111-4111-8111-111111111112', 'running', now() - interval '20 minutes');
SET LOCAL ROLE athlya_app;

SELECT ok(
    export_job_claim('e4980000-0000-7000-8000-000000000004'),
    'export_job_claim: a running job with an expired lease is reclaimed'
);

SELECT ok(
    export_job_fail('e4980000-0000-7000-8000-000000000004', repeat('x', 900)),
    'export_job_fail: fails a running job'
);

SELECT is(
    (SELECT length(error) FROM export_job_get('e4980000-0000-7000-8000-000000000004')),
    500,
    'export_job_fail: the stored reason is bounded'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
