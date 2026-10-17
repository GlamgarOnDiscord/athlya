-- =====================================================================
-- studios_runtime.sql — `studios` under the real athlya_app role
-- (migration 0038, issues #224 / #117)
--
-- Asserts that:
--   - without tenant GUCs athlya_app sees no studio row (FORCE RLS);
--   - `studio_id_by_slug` resolves a live slug pre-auth, returns NULL
--     for an unknown or tombstoned slug, and is locked down
--     (SECURITY DEFINER, athlya_owner, pinned search_path, no PUBLIC);
--   - with tenant GUCs the read policy returns the caller's studio only;
--   - `studios_admin_update_own` lets an admin edit their own studio,
--     and silently matches nothing for a member or another studio's
--     admin;
--   - the column grant keeps `slug` immutable for the application.
--
-- Writes and their read-backs are separate statements: `app_studio_id()`
-- and `app_role()` are STABLE (see CLAUDE.md, pgTAP note).
-- =====================================================================

BEGIN;
SELECT plan(17);

INSERT INTO studios (id, slug, name, deleted_at)
VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'studio-gone', 'Gone', now());

-- ---------- function hardening (as the migration superuser) ----------

SELECT ok(
    (SELECT prosecdef FROM pg_proc WHERE oid = 'studio_id_by_slug(text)'::regprocedure),
    'studio_id_by_slug: SECURITY DEFINER'
);

SELECT is(
    (SELECT pg_get_userbyid(proowner)::text FROM pg_proc WHERE oid = 'studio_id_by_slug(text)'::regprocedure),
    'athlya_owner',
    'studio_id_by_slug: owned by athlya_owner'
);

SELECT ok(
    (SELECT 'search_path=public, pg_temp' = ANY (proconfig)
       FROM pg_proc WHERE oid = 'studio_id_by_slug(text)'::regprocedure),
    'studio_id_by_slug: search_path pinned to public, pg_temp'
);

SELECT ok(
    NOT has_function_privilege('public', 'studio_id_by_slug(text)', 'EXECUTE'),
    'studio_id_by_slug: EXECUTE not granted to PUBLIC'
);

SELECT ok(
    NOT has_function_privilege('athlya_cron', 'studio_id_by_slug(text)', 'EXECUTE'),
    'studio_id_by_slug: EXECUTE not granted to athlya_cron'
);

SET LOCAL ROLE athlya_app;

-- ---------- pre-auth: no tenant GUCs ----------

SELECT is(
    (SELECT count(*)::int FROM studios),
    0,
    'athlya_app without tenant GUCs reads zero studios rows directly'
);

SELECT is(
    studio_id_by_slug('studio-a'),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    'studio_id_by_slug: resolves a live slug without tenant context'
);

SELECT is(
    studio_id_by_slug('no-such-studio'),
    NULL::uuid,
    'studio_id_by_slug: unknown slug returns NULL'
);

SELECT is(
    studio_id_by_slug('studio-gone'),
    NULL::uuid,
    'studio_id_by_slug: tombstoned studio returns NULL'
);

-- ---------- tenant read ----------

SELECT set_config('app.user_id', '11111111-1111-4111-8111-111111111111', true);
SELECT set_config('app.studio_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
SELECT set_config('app.role', 'member', true);

SELECT results_eq(
    $$ SELECT id, slug FROM studios $$,
    $$ VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'studio-a'::text) $$,
    'studios_read_own_tenant: athlya_app with claims reads its own studio only'
);

-- ---------- member cannot update ----------

UPDATE studios SET name = 'Member Edit' WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

SELECT is(
    (SELECT name FROM studios WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    'Studio Alpha',
    'studios_admin_update_own: a member cannot update the studio'
);

-- ---------- another studio's admin cannot update ----------

SELECT set_config('app.user_id', '22222222-2222-4222-8222-222222222222', true);
SELECT set_config('app.studio_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
SELECT set_config('app.role', 'admin', true);

UPDATE studios SET name = 'Cross Tenant' WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

-- ---------- own admin updates branding ----------

SELECT set_config('app.user_id', '11111111-1111-4111-8111-111111111113', true);
SELECT set_config('app.studio_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
SELECT set_config('app.role', 'admin', true);

SELECT is(
    (SELECT name FROM studios WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    'Studio Alpha',
    'studios_admin_update_own: an admin of studio B cannot update studio A'
);

UPDATE studios SET name = 'Studio Alpha Renamed', brand_color = '#1D4ED8'
 WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

SELECT results_eq(
    $$ SELECT name, brand_color FROM studios WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$,
    $$ VALUES ('Studio Alpha Renamed'::text, '#1D4ED8'::text) $$,
    'studios_admin_update_own: an admin updates name and brand color of their studio'
);

SELECT throws_ok(
    $$ UPDATE studios SET slug = 'hijacked' WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$,
    '42501',
    NULL,
    'column grant: athlya_app cannot change a studio slug'
);

SELECT throws_ok(
    $$ UPDATE studios SET deleted_at = now() WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$,
    '42501',
    NULL,
    'column grant: athlya_app cannot tombstone a studio'
);

SELECT throws_ok(
    $$ INSERT INTO studios (slug, name) VALUES ('rogue', 'Rogue') $$,
    '42501',
    NULL,
    'athlya_app cannot create studios'
);

-- ---------- admin of studio B still sees only studio B ----------

SELECT set_config('app.user_id', '22222222-2222-4222-8222-222222222222', true);
SELECT set_config('app.studio_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);

SELECT is(
    (SELECT count(*)::int FROM studios WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    0,
    'studios_read_own_tenant: admin of studio B does not see studio A'
);

SELECT * FROM finish();
ROLLBACK;
