-- =====================================================================
-- outbox_lease.sql — leased claim as athlya_cron (issue #424)
--
-- The drain claims with one autocommit statement that stamps
-- `lease_until`; leased rows are not claimable until the lease lapses.
-- =====================================================================

BEGIN;
SELECT plan(6);

INSERT INTO outbox (id, event_id, event_type, payload, occurred_at, studio_id) VALUES
    ('0424aaaa-0000-4000-8000-000000000001', 'evt-424-1', 'test.lease', '{}'::jsonb,
     now() - interval '2 minutes', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

SET LOCAL ROLE athlya_cron;

PREPARE claim_lease AS
    WITH claimed AS (
        SELECT id FROM outbox
         WHERE published_at IS NULL
           AND (lease_until IS NULL OR lease_until <= now())
           AND event_type = 'test.lease'
         ORDER BY occurred_at
         LIMIT 10
         FOR UPDATE SKIP LOCKED
    )
    UPDATE outbox
       SET attempts = outbox.attempts + 1,
           lease_until = now() + make_interval(secs => 120)
      FROM claimed
     WHERE outbox.id = claimed.id
    RETURNING outbox.id;

SELECT results_eq(
    'EXECUTE claim_lease',
    $$ VALUES ('0424aaaa-0000-4000-8000-000000000001'::uuid) $$,
    'athlya_cron claims a pending row and stamps a lease'
);

SELECT is_empty(
    'EXECUTE claim_lease',
    'a leased row is not claimable by an overlapping drain'
);

RESET ROLE;
UPDATE outbox SET lease_until = now() - interval '1 second'
 WHERE id = '0424aaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE athlya_cron;

SELECT results_eq(
    'EXECUTE claim_lease',
    $$ VALUES ('0424aaaa-0000-4000-8000-000000000001'::uuid) $$,
    'an expired lease (dead drain) is re-claimed'
);

UPDATE outbox SET published_at = now(), lease_until = NULL
 WHERE id = ANY('{0424aaaa-0000-4000-8000-000000000001}'::uuid[]);

SELECT results_eq(
    $$ SELECT published_at IS NOT NULL, lease_until IS NULL, attempts
         FROM outbox WHERE id = '0424aaaa-0000-4000-8000-000000000001' $$,
    $$ VALUES (true, true, 2) $$,
    'markPublishedMany stamps published_at and clears the lease'
);

SELECT is_empty(
    'EXECUTE claim_lease',
    'a published row is never claimed again'
);

SELECT throws_ok(
    $$ UPDATE outbox SET payload = '{"x":1}'::jsonb WHERE id = '0424aaaa-0000-4000-8000-000000000001' $$,
    '42501',
    NULL,
    'athlya_cron still cannot rewrite payloads (column grant: attempts, published_at, lease_until)'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
