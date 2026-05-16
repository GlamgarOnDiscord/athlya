-- =====================================================================
-- studios.sql — exercises `studios_read_own_tenant`
--
-- Requirement 13.6: a tenant only ever sees its own `studios` row.
-- Policy: SELECT USING (id = public.app_studio_id())
--
-- We set the tenant to a studio A member and assert:
--   (a) the studio A row is visible (count = 1)
--   (b) the studio B row is invisible (count = 0 for id = B)
--   (c) the full SELECT without WHERE only returns 1 row (A)
--
-- All assertions run inside a single transaction rolled back at the
-- end; pgTAP's `plan(N)` primes the framework to expect N assertions.
-- =====================================================================

BEGIN;
-- Switch to the non-superuser test role so RLS policies actually
-- apply. The session role (postgres) is a superuser and therefore
-- bypasses RLS; the enclosing ROLLBACK restores it at file end.
SET LOCAL ROLE athlya_tenant_test;
SELECT plan(3);

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111111',  -- member A
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',  -- studio A
    'member'
);

SELECT is(
    (SELECT count(*)::int FROM "studios" WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    1,
    'studios_read_own_tenant: member of studio A sees studio A row'
);

SELECT is(
    (SELECT count(*)::int FROM "studios" WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    0,
    'studios_read_own_tenant: member of studio A does NOT see studio B row (cross-tenant hidden)'
);

SELECT is(
    (SELECT count(*)::int FROM "studios"),
    1,
    'studios_read_own_tenant: unfiltered SELECT returns exactly 1 row (own studio)'
);

SELECT * FROM finish();
ROLLBACK;
