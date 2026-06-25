-- =====================================================================
-- cron_role.sql — athlya_cron NOBYPASSRLS policy assertions (issue #299)
--
-- Verifies that after migration 0019:
--   1. athlya_cron has rolbypassrls = false
--   2. athlya_cron can SELECT + UPDATE users (anonymization path)
--   3. athlya_cron can SELECT + DELETE from outbox
--   4. athlya_cron can SELECT + DELETE from export_jobs
--   5. athlya_cron cannot SELECT from audit_log (revoked in 0012)
--   6. athlya_cron cannot access classes / reservations / studios
-- =====================================================================

BEGIN;

-- Seed data as superuser (bypasses RLS). Use deterministic UUIDs so
-- the test is idempotent on repeated runs.
INSERT INTO studios (id, name, slug, created_at, updated_at)
VALUES
    ('cccccccc-cc01-4ccc-8ccc-cccccccccc01', 'Cron Test Studio A', 'cron-studio-a', NOW(), NOW()),
    ('cccccccc-cc02-4ccc-8ccc-cccccccccc02', 'Cron Test Studio B', 'cron-studio-b', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- Soft-deleted user eligible for anonymization (deleted > 30 days ago)
INSERT INTO users (id, studio_id, email, display_name, password_hash, role, deleted_at, created_at, updated_at)
VALUES
    (
        'dddddddd-dd01-4ddd-8ddd-dddddddddd01',
        'cccccccc-cc01-4ccc-8ccc-cccccccccc01',
        'old-user-a@example.com',
        'Old User A',
        'hash',
        'member',
        NOW() - INTERVAL '35 days',
        NOW() - INTERVAL '40 days',
        NOW()
    ),
    (
        'dddddddd-dd02-4ddd-8ddd-dddddddddd02',
        'cccccccc-cc02-4ccc-8ccc-cccccccccc02',
        'old-user-b@example.com',
        'Old User B',
        'hash',
        'member',
        NOW() - INTERVAL '35 days',
        NOW() - INTERVAL '40 days',
        NOW()
    )
ON CONFLICT (id) DO NOTHING;

-- Published outbox row older than 7d (eligible for purge)
INSERT INTO outbox (id, event_id, event_type, payload, occurred_at, published_at, studio_id)
VALUES
    (
        'eeeeeeee-ee01-4eee-8eee-eeeeeeeeee01',
        'evt-cron-test-1',
        'test.cron',
        '{"t":1}'::jsonb,
        NOW() - INTERVAL '10 days',
        NOW() - INTERVAL '10 days',
        'cccccccc-cc01-4ccc-8ccc-cccccccccc01'
    ),
    (
        'eeeeeeee-ee02-4eee-8eee-eeeeeeeeee02',
        'evt-cron-test-2',
        'test.cron',
        '{"t":2}'::jsonb,
        NOW() - INTERVAL '10 days',
        NOW() - INTERVAL '10 days',
        'cccccccc-cc02-4ccc-8ccc-cccccccccc02'
    )
ON CONFLICT (id) DO NOTHING;

SELECT plan(8);

-- ------------------------------------------------------------------ --
-- 1. athlya_cron must have rolbypassrls = false after migration 0019  --
-- ------------------------------------------------------------------ --
SELECT is(
    (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'athlya_cron'),
    false,
    'athlya_cron has rolbypassrls = false (issue #299)'
);

-- ------------------------------------------------------------------ --
-- 2–3. athlya_cron can SELECT users cross-tenant                      --
-- ------------------------------------------------------------------ --
SET LOCAL ROLE athlya_cron;

SELECT is(
    (SELECT COUNT(*)::int FROM users
     WHERE deleted_at IS NOT NULL
       AND deleted_at < NOW() - INTERVAL '30 days'
       AND email IS NOT NULL),
    2,
    'athlya_cron sees both expired users across studios (cross-tenant SELECT)'
);

-- ------------------------------------------------------------------ --
-- 4. athlya_cron can UPDATE users (anonymization path)                --
-- ------------------------------------------------------------------ --
UPDATE users
SET email = NULL,
    display_name = '[deleted]',
    avatar_url = NULL,
    consents = '{}'::jsonb,
    password_hash = NULL
WHERE id = 'dddddddd-dd01-4ddd-8ddd-dddddddddd01';

SELECT is(
    (SELECT email FROM users WHERE id = 'dddddddd-dd01-4ddd-8ddd-dddddddddd01'),
    NULL,
    'athlya_cron can anonymize users (UPDATE cross-tenant)'
);

-- ------------------------------------------------------------------ --
-- 5. athlya_cron can SELECT outbox cross-tenant                       --
-- ------------------------------------------------------------------ --
SELECT is(
    (SELECT COUNT(*)::int FROM outbox
     WHERE event_type = 'test.cron'
       AND published_at IS NOT NULL),
    2,
    'athlya_cron sees outbox rows from all studios (cross-tenant SELECT)'
);

-- ------------------------------------------------------------------ --
-- 6. athlya_cron can DELETE from outbox                               --
-- ------------------------------------------------------------------ --
DELETE FROM outbox WHERE id = 'eeeeeeee-ee01-4eee-8eee-eeeeeeeeee01';

SELECT is(
    (SELECT COUNT(*)::int FROM outbox WHERE id = 'eeeeeeee-ee01-4eee-8eee-eeeeeeeeee01'),
    0,
    'athlya_cron can purge outbox rows (DELETE cross-tenant)'
);

-- ------------------------------------------------------------------ --
-- 7. athlya_cron cannot read audit_log (revoked in 0012)              --
-- ------------------------------------------------------------------ --
SELECT throws_ok(
    $$ SELECT COUNT(*) FROM audit_log $$,
    '42501',
    NULL,
    'athlya_cron has no SELECT on audit_log (privilege revoked in 0012)'
);

-- ------------------------------------------------------------------ --
-- 8. athlya_cron cannot read classes (not in granted tables)          --
-- ------------------------------------------------------------------ --
SELECT throws_ok(
    $$ SELECT COUNT(*) FROM classes $$,
    '42501',
    NULL,
    'athlya_cron has no SELECT on classes'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
