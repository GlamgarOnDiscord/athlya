-- =====================================================================
-- idempotency_keys.sql — owner-scoped policies on idempotency store
--
-- Covered policies (Req 20.x):
--   - idempotency_keys_read_own    SELECT USING user_id = app_user_id()
--   - idempotency_keys_insert_own  INSERT WITH CHECK user_id = app_user_id()
--   - idempotency_keys_delete_own  DELETE USING user_id = app_user_id()
--
-- No UPDATE policy: idempotency rows are write-once (INSERT) then read
-- until TTL expiry, at which point the cleanup job deletes them.
-- =====================================================================

BEGIN;
-- Switch to the non-superuser test role so RLS policies actually
-- apply. The session role (postgres) is a superuser and therefore
-- bypasses RLS; the enclosing ROLLBACK restores it at file end.
SET LOCAL ROLE athlya_tenant_test;
SELECT plan(6);

-- ---------- idempotency_keys_read_own ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111111',  -- member A
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

SELECT is(
    (SELECT count(*)::int FROM "idempotency_keys" WHERE user_id = '11111111-1111-4111-8111-111111111111'),
    1,
    'idempotency_keys_read_own: member A sees own idempotency row'
);

SELECT is_empty(
    $$SELECT key FROM "idempotency_keys" WHERE user_id = '22222222-2222-4222-8222-222222222221'$$,
    'idempotency_keys_read_own: member A does NOT see member B idempotency rows'
);

-- ---------- idempotency_keys_insert_own ----------

SELECT lives_ok(
    $$INSERT INTO "idempotency_keys" (key, user_id, response, status_code, expires_at)
      VALUES ('key-test-self', '11111111-1111-4111-8111-111111111111', '{"ok":true}'::jsonb, 200, '2099-01-01 00:00:00+00')$$,
    'idempotency_keys_insert_own: member A can INSERT own key'
);

SELECT throws_ok(
    $$INSERT INTO "idempotency_keys" (key, user_id, response, status_code, expires_at)
      VALUES ('key-test-forge', '22222222-2222-4222-8222-222222222221', '{"ok":true}'::jsonb, 200, '2099-01-01 00:00:00+00')$$,
    '42501',
    NULL,
    'idempotency_keys_insert_own: member A cannot INSERT key for member B (SQLSTATE 42501)'
);

-- ---------- idempotency_keys_delete_own ----------

SELECT is(
    (WITH del AS (
        DELETE FROM "idempotency_keys" WHERE key = 'key-seed-a' AND user_id = '11111111-1111-4111-8111-111111111111'
        RETURNING key
     )
     SELECT count(*)::int FROM del),
    1,
    'idempotency_keys_delete_own: member A can DELETE own key'
);

SELECT is(
    (WITH del AS (
        DELETE FROM "idempotency_keys" WHERE key = 'key-seed-b' AND user_id = '22222222-2222-4222-8222-222222222221'
        RETURNING key
     )
     SELECT count(*)::int FROM del),
    0,
    'idempotency_keys_delete_own: member A cannot DELETE member B key (zero rows)'
);

SELECT * FROM finish();
ROLLBACK;
