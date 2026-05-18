-- =====================================================================
-- users.sql — exercises four `users_*` policies
--
-- Covered policies:
--   - users_read_own         SELECT USING id = app_user_id()
--   - users_read_same_studio SELECT USING studio_id = app_studio_id()
--                                        AND app_role() IN ('admin','coach')
--   - users_update_own       UPDATE USING id = app_user_id()
--   - users_update_admin     UPDATE USING studio_id = app_studio_id()
--                                        AND app_role() = 'admin'
--
-- Requirement mapping: 13.2 (per-row scoping on users).
-- =====================================================================

BEGIN;
-- Switch to the non-superuser test role so RLS policies actually
-- apply. The session role (postgres) is a superuser and therefore
-- bypasses RLS; the enclosing ROLLBACK restores it at file end.
SET LOCAL ROLE athlya_tenant_test;
SELECT plan(11);

-- ---------- users_read_own ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111111',  -- member A
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

-- Own row: visible.
SELECT is(
    (SELECT count(*)::int FROM "users" WHERE id = '11111111-1111-4111-8111-111111111111'),
    1,
    'users_read_own: member A sees their own row'
);

-- Member A2 (same studio) is invisible because members only have
-- `users_read_own`, not `users_read_same_studio`.
SELECT is(
    (SELECT count(*)::int FROM "users" WHERE id = '11111111-1111-4111-8111-111111111112'),
    0,
    'users_read_own: member A does NOT see other member of same studio'
);

-- Cross-tenant is always invisible — this is the core Req 13.2 case.
SELECT is_empty(
    $$SELECT id FROM "users" WHERE id = '22222222-2222-4222-8222-222222222221'$$,
    'users_read_own: cross-tenant SELECT returns zero rows (member B invisible to member A)'
);

-- ---------- users_read_same_studio (role = admin) ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111113',  -- admin A
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'admin'
);

-- Admin A should see all four users in studio A.
SELECT is(
    (SELECT count(*)::int FROM "users" WHERE studio_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    4,
    'users_read_same_studio: admin A sees all 4 members of studio A'
);

-- Admin A should see zero users in studio B.
SELECT is(
    (SELECT count(*)::int FROM "users" WHERE studio_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    0,
    'users_read_same_studio: admin A cannot see users of studio B (cross-tenant hidden)'
);

-- ---------- users_read_same_studio (role = coach) ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111114',  -- coach A
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'coach'
);

SELECT is(
    (SELECT count(*)::int FROM "users" WHERE studio_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    4,
    'users_read_same_studio: coach A sees all 4 members of studio A'
);

SELECT is(
    (SELECT count(*)::int FROM "users" WHERE studio_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    0,
    'users_read_same_studio: coach A cannot see users of studio B'
);

-- ---------- users_update_own ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111111',  -- member A
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

-- Updating own row succeeds and RETURNING yields one row.
WITH upd AS (
    UPDATE "users" SET display_name = 'Member A (self-update)'
    WHERE id = '11111111-1111-4111-8111-111111111111'
    RETURNING id
)
SELECT is(count(*)::int, 1, 'users_update_own: member A can update their own row') FROM upd;

-- Updating a cross-tenant row silently affects zero rows because RLS
-- strips member B out of the UPDATE's candidate set.
WITH upd AS (
    UPDATE "users" SET display_name = 'hacked'
    WHERE id = '22222222-2222-4222-8222-222222222221'
    RETURNING id
)
SELECT is(count(*)::int, 0, 'users_update_own: member A cannot UPDATE cross-tenant user (zero rows affected)') FROM upd;

-- ---------- users_update_admin ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111113',  -- admin A
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'admin'
);

-- Admin A can update any user in studio A (here: member_A2).
WITH upd AS (
    UPDATE "users" SET display_name = 'Renamed by admin A'
    WHERE id = '11111111-1111-4111-8111-111111111112'
    RETURNING id
)
SELECT is(count(*)::int, 1, 'users_update_admin: admin A can update a member of studio A') FROM upd;

-- Admin A cannot update a user from studio B — RLS returns zero rows.
WITH upd AS (
    UPDATE "users" SET display_name = 'cross-tenant'
    WHERE id = '22222222-2222-4222-8222-222222222221'
    RETURNING id
)
SELECT is(count(*)::int, 0, 'users_update_admin: admin A cannot update user of studio B (zero rows affected)') FROM upd;

SELECT * FROM finish();
ROLLBACK;
