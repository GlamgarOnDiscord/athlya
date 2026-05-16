-- =====================================================================
-- push_tokens.sql — owner-scoped push token policies
--
-- Covered policies (Req 17.x, 5.x):
--   - push_tokens_read_own    SELECT USING user_id = app_user_id()
--   - push_tokens_insert_own  INSERT WITH CHECK user_id = app_user_id()
--   - push_tokens_delete_own  DELETE USING user_id = app_user_id()
--
-- No UPDATE policy: push tokens are treated as immutable — on token
-- rotation the client deletes the old row and inserts a new one.
-- =====================================================================

BEGIN;
-- Switch to the non-superuser test role so RLS policies actually
-- apply. The session role (postgres) is a superuser and therefore
-- bypasses RLS; the enclosing ROLLBACK restores it at file end.
SET LOCAL ROLE athlya_tenant_test;
SELECT plan(6);

-- ---------- push_tokens_read_own ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111111',  -- member A
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

SELECT is(
    (SELECT count(*)::int FROM "push_tokens" WHERE user_id = '11111111-1111-4111-8111-111111111111'),
    1,
    'push_tokens_read_own: member A sees own token'
);

SELECT is_empty(
    $$SELECT id FROM "push_tokens" WHERE user_id = '22222222-2222-4222-8222-222222222221'$$,
    'push_tokens_read_own: member A does NOT see member B token (cross-tenant hidden)'
);

-- ---------- push_tokens_insert_own ----------

SELECT lives_ok(
    $$INSERT INTO "push_tokens" (user_id, platform, token)
      VALUES ('11111111-1111-4111-8111-111111111111', 'web', 'self-token-1')$$,
    'push_tokens_insert_own: member A can INSERT own token'
);

SELECT throws_ok(
    $$INSERT INTO "push_tokens" (user_id, platform, token)
      VALUES ('22222222-2222-4222-8222-222222222221', 'web', 'forged-token-1')$$,
    '42501',
    NULL,
    'push_tokens_insert_own: member A cannot INSERT token for member B (SQLSTATE 42501)'
);

-- ---------- push_tokens_delete_own ----------

SELECT is(
    (WITH del AS (
        DELETE FROM "push_tokens" WHERE id = '99999999-9999-4999-8999-999999999901'
        RETURNING id
     )
     SELECT count(*)::int FROM del),
    1,
    'push_tokens_delete_own: member A can DELETE own token'
);

SELECT is(
    (WITH del AS (
        DELETE FROM "push_tokens" WHERE id = '99999999-9999-4999-8999-999999999902'
        RETURNING id
     )
     SELECT count(*)::int FROM del),
    0,
    'push_tokens_delete_own: member A cannot DELETE member B token (zero rows affected)'
);

SELECT * FROM finish();
ROLLBACK;
