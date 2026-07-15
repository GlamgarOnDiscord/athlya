-- =====================================================================
-- export_jobs.sql — RLS policy assertions for the export_jobs table
--
-- Policies under test (added in 0002_export_jobs.sql and later migrations):
--   - export_jobs_read_own  : member can SELECT only their own job rows
-- =====================================================================

BEGIN;

-- Seed: two export_jobs, one for member-a, one for member-b
INSERT INTO export_jobs (id, user_id, status, requested_at)
VALUES
    (
        'eeee0001-e001-4eee-8eee-000000000001',
        '11111111-1111-4111-8111-111111111111',
        'completed',
        NOW() - INTERVAL '1 hour'
    ),
    (
        'eeee0002-e002-4eee-8eee-000000000002',
        '22222222-2222-4222-8222-222222222221',
        'pending',
        NOW() - INTERVAL '10 minutes'
    )
ON CONFLICT (id) DO NOTHING;

SELECT plan(2);

-- ------------------------------------------------------------------ --
-- export_jobs_read_own: member sees only their own rows               --
-- ------------------------------------------------------------------ --
SELECT test_set_tenant(
    '11111111-1111-4111-8111-111111111111'::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    'member'
);

SELECT is(
    (SELECT COUNT(*)::int FROM export_jobs),
    1,
    'export_jobs_read_own: member-a sees only their own export_jobs row'
);

-- ------------------------------------------------------------------ --
-- export_jobs_read_own: member from studio B cannot read studio A row  --
-- ------------------------------------------------------------------ --
SELECT test_set_tenant(
    '22222222-2222-4222-8222-222222222221'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    'member'
);

SELECT is(
    (SELECT COUNT(*)::int FROM export_jobs
     WHERE id = 'eeee0001-e001-4eee-8eee-000000000001'),
    0,
    'export_jobs_read_own: member-b cannot read member-a export_jobs row'
);

SELECT test_unset_tenant();

SELECT * FROM finish();
ROLLBACK;
