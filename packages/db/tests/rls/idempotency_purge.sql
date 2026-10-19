-- =====================================================================
-- idempotency_purge.sql — migration 0047 under the real athlya_cron
-- role (audit S4-011)
--
-- Asserts that:
--   - `idempotency_purge_expired` is SECURITY DEFINER, owned by
--     athlya_owner, with a pinned search_path and EXECUTE for
--     athlya_cron only;
--   - athlya_cron still has no direct access to idempotency_keys;
--   - the function deletes expired rows only, oldest first, at most
--     `p_limit` per call, and returns the count;
--   - an out-of-range limit raises 22023.
--
-- Writes and their read-backs are separate statements (see CLAUDE.md
-- pgTAP note).
-- =====================================================================

BEGIN;
SELECT plan(11);

-- Seed as the migration superuser: three expired keys of members A and
-- B next to the live bootstrap rows (expiring in 2099).
INSERT INTO idempotency_keys (key, user_id, response, status_code, expires_at) VALUES
    ('key-expired-1', '11111111-1111-4111-8111-111111111111', '{"ok":true}'::jsonb, 200, now() - interval '3 days'),
    ('key-expired-2', '11111111-1111-4111-8111-111111111111', '{"ok":true}'::jsonb, 200, now() - interval '2 days'),
    ('key-expired-3', '22222222-2222-4222-8222-222222222221', '{"ok":true}'::jsonb, 200, now() - interval '1 hour');

-- ---------- hardening ----------

SELECT ok(
    (SELECT p.prosecdef
        AND pg_get_userbyid(p.proowner) = 'athlya_owner'
        AND 'search_path=public, pg_temp' = ANY (p.proconfig)
        AND has_function_privilege('athlya_cron', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('athlya_app', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
       FROM pg_proc p
      WHERE p.oid = 'idempotency_purge_expired(integer)'::regprocedure),
    'idempotency_purge_expired: SECURITY DEFINER, athlya_owner, pinned search_path, athlya_cron only'
);

-- ---------- athlya_app ----------

SET LOCAL ROLE athlya_app;

SELECT throws_ok(
    $$ SELECT idempotency_purge_expired(10) $$,
    '42501',
    NULL,
    'athlya_app cannot execute idempotency_purge_expired'
);

RESET ROLE;

-- ---------- athlya_cron ----------

SET LOCAL ROLE athlya_cron;

SELECT throws_ok(
    $$ SELECT key FROM idempotency_keys $$,
    '42501',
    NULL,
    'athlya_cron has no direct read access to idempotency_keys'
);

SELECT throws_ok(
    $$ SELECT idempotency_purge_expired(0) $$,
    '22023',
    NULL,
    'idempotency_purge_expired: a zero limit is refused'
);

SELECT throws_ok(
    $$ SELECT idempotency_purge_expired(10001) $$,
    '22023',
    NULL,
    'idempotency_purge_expired: a limit above 10 000 is refused'
);

SELECT is(
    idempotency_purge_expired(2),
    2,
    'idempotency_purge_expired: deletes at most p_limit expired rows'
);

RESET ROLE;

SELECT set_eq(
    $$ SELECT key FROM idempotency_keys WHERE expires_at <= now() $$,
    ARRAY['key-expired-3'],
    'idempotency_purge_expired: the oldest expired rows go first'
);

SET LOCAL ROLE athlya_cron;

SELECT is(
    idempotency_purge_expired(100),
    1,
    'idempotency_purge_expired: the next call deletes the remaining expired row'
);

SELECT is(
    idempotency_purge_expired(100),
    0,
    'idempotency_purge_expired: nothing left to delete'
);

RESET ROLE;

-- ---------- read-back as the superuser ----------

SELECT is_empty(
    $$ SELECT key FROM idempotency_keys WHERE expires_at <= now() $$,
    'every expired idempotency key is gone'
);

SELECT set_eq(
    $$ SELECT key FROM idempotency_keys $$,
    ARRAY['key-seed-a', 'key-seed-b'],
    'live idempotency keys of both studios are kept'
);

SELECT * FROM finish();
ROLLBACK;
