-- =====================================================================
-- white_label.sql: studio logos, custom domains and the branding read
-- of the notifications consumer (migration 0053, issue #761)
--
-- Asserts that:
--   - an admin updates the logo columns and the Athlya mention flag of
--     their studio under the athlya_app role; the CHECK refuses a logo
--     that is neither an https URL nor a data:image URL;
--   - `studio_domains_admin_own` lets an admin of the studio read and
--     write its domains, and hides them from a member and from another
--     studio's admin;
--   - athlya_app cannot set `activated_at` or `dkim_record` (operator
--     columns), and a hostname change resets verification and
--     activation;
--   - two studios may claim one hostname while pending, but only one
--     row per (kind, hostname) can be verified;
--   - `notification_studio_branding` is locked down and returns the
--     sending domain only once verified and activated.
--
-- Writes and their read-backs are separate statements: `app_studio_id()`
-- and `app_role()` are STABLE (see CLAUDE.md, pgTAP note).
-- =====================================================================

BEGIN;
SELECT plan(26);

-- ---------- function hardening (as the migration superuser) ----------

SELECT ok(
    (SELECT prosecdef FROM pg_proc WHERE oid = 'notification_studio_branding(uuid)'::regprocedure),
    'notification_studio_branding: SECURITY DEFINER'
);

SELECT is(
    (SELECT pg_get_userbyid(proowner)::text FROM pg_proc
      WHERE oid = 'notification_studio_branding(uuid)'::regprocedure),
    'athlya_owner',
    'notification_studio_branding: owned by athlya_owner'
);

SELECT ok(
    (SELECT 'search_path=public, pg_temp' = ANY (proconfig)
       FROM pg_proc WHERE oid = 'notification_studio_branding(uuid)'::regprocedure),
    'notification_studio_branding: search_path pinned to public, pg_temp'
);

SELECT ok(
    NOT has_function_privilege('public', 'notification_studio_branding(uuid)', 'EXECUTE'),
    'notification_studio_branding: EXECUTE not granted to PUBLIC'
);

SELECT ok(
    NOT has_function_privilege('athlya_cron', 'notification_studio_branding(uuid)', 'EXECUTE'),
    'notification_studio_branding: EXECUTE not granted to athlya_cron'
);

SELECT ok(
    (SELECT 'search_path=public, pg_temp' = ANY (proconfig)
       FROM pg_proc WHERE oid = 'studio_domains_reset_on_hostname_change()'::regprocedure),
    'studio_domains_reset_on_hostname_change: search_path pinned to public, pg_temp'
);

SELECT ok(
    (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'studio_domains'::regclass),
    'studio_domains: FORCE ROW LEVEL SECURITY'
);

SET LOCAL ROLE athlya_app;

-- ---------- studio logos and the Athlya mention ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111113', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin');

UPDATE studios
   SET brand_logo_light = 'https://assets.athlya.test/studio-logos/a/light?v=1',
       brand_logo_dark = 'data:image/png;base64,iVBORw0KGgo=',
       hide_athlya_branding = true
 WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

SELECT results_eq(
    $$ SELECT brand_logo_light, brand_logo_dark, hide_athlya_branding
         FROM studios WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$,
    $$ VALUES ('https://assets.athlya.test/studio-logos/a/light?v=1'::text,
               'data:image/png;base64,iVBORw0KGgo='::text, true) $$,
    'studios_admin_update_own: an admin sets the logos and hides the Athlya mention'
);

SELECT throws_ok(
    $$ UPDATE studios SET brand_logo_light = 'javascript:alert(1)'
        WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$,
    '23514',
    NULL,
    'studios_brand_logo_light_check: refuses a logo that is not https or data:image'
);

SELECT throws_ok(
    $$ UPDATE studios SET brand_logo_dark = 'data:image/svg+xml;base64,PHN2Zz4='
        WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$,
    '23514',
    NULL,
    'studios_brand_logo_dark_check: refuses an SVG data URL'
);

-- ---------- domains: admin of the studio ----------

INSERT INTO studio_domains (studio_id, kind, hostname, verification_token)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'email', 'studio-alpha.test', repeat('a', 32)),
       ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'web', 'club.studio-alpha.test', repeat('b', 32));

SELECT is(
    (SELECT count(*)::int FROM studio_domains),
    2,
    'studio_domains_admin_own: an admin reads the domains of their studio'
);

SELECT throws_ok(
    $$ INSERT INTO studio_domains (studio_id, kind, hostname, verification_token)
       VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'web', 'rogue.test', repeat('c', 32)) $$,
    '42501',
    NULL,
    'studio_domains_admin_own: an admin cannot insert a domain for another studio'
);

SELECT throws_ok(
    $$ INSERT INTO studio_domains (studio_id, kind, hostname, verification_token)
       VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'web', 'second.studio-alpha.test', repeat('d', 32)) $$,
    '23505',
    NULL,
    'studio_domains_studio_kind_unique: one web domain per studio'
);

SELECT throws_ok(
    $$ INSERT INTO studio_domains (studio_id, kind, hostname, verification_token)
       VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'web', 'Upper.Test', repeat('d', 32)) $$,
    '23514',
    NULL,
    'studio_domains_hostname_check: refuses a hostname that is not lower case'
);

SELECT throws_ok(
    $$ UPDATE studio_domains SET activated_at = now() WHERE kind = 'email' $$,
    '42501',
    NULL,
    'column grant: athlya_app cannot activate a domain'
);

SELECT throws_ok(
    $$ UPDATE studio_domains SET dkim_record = 'p=abc' WHERE kind = 'email' $$,
    '42501',
    NULL,
    'column grant: athlya_app cannot write the DKIM value'
);

UPDATE studio_domains SET status = 'verified', verified_at = now() WHERE kind = 'email';

-- ---------- branding read: verified but not activated ----------

SELECT test_unset_tenant();

SELECT results_eq(
    $$ SELECT studio_name, brand_logo_light, hide_athlya_branding, email_domain
         FROM notification_studio_branding('11111111-1111-4111-8111-111111111111') $$,
    $$ VALUES ('Studio Alpha'::text, 'https://assets.athlya.test/studio-logos/a/light?v=1'::text,
               true, NULL::text) $$,
    'notification_studio_branding: no sending domain before the operator activates it'
);

RESET ROLE;
UPDATE studio_domains SET activated_at = now(), dkim_record = 'p=abc' WHERE kind = 'email';
SET LOCAL ROLE athlya_app;

SELECT is(
    (SELECT email_domain FROM notification_studio_branding('11111111-1111-4111-8111-111111111111')),
    'studio-alpha.test',
    'notification_studio_branding: the sending domain once verified and activated'
);

SELECT is(
    (SELECT count(*)::int FROM notification_studio_branding('00000000-0000-4000-8000-000000000000')),
    0,
    'notification_studio_branding: unknown user returns no row'
);

-- ---------- hostname change resets verification and activation ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111113', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin');

UPDATE studio_domains SET hostname = 'mail.studio-alpha.test' WHERE kind = 'email';

SELECT results_eq(
    $$ SELECT status, verified_at IS NULL, activated_at IS NULL, dkim_record IS NULL
         FROM studio_domains WHERE kind = 'email' $$,
    $$ VALUES ('pending'::text, true, true, true) $$,
    'studio_domains_reset_on_hostname_change: a new hostname starts over'
);

-- ---------- a member and another studio's admin see nothing ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member');

SELECT is(
    (SELECT count(*)::int FROM studio_domains),
    0,
    'studio_domains_admin_own: a member does not see the domains of their studio'
);

DELETE FROM studio_domains;

SELECT test_set_tenant('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'admin');

SELECT is(
    (SELECT count(*)::int FROM studio_domains),
    0,
    'studio_domains_admin_own: an admin of studio B does not see studio A domains'
);

-- ---------- one verified owner per hostname ----------

INSERT INTO studio_domains (studio_id, kind, hostname, verification_token)
VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'web', 'club.studio-alpha.test', repeat('e', 32));

SELECT is(
    (SELECT count(*)::int FROM studio_domains WHERE hostname = 'club.studio-alpha.test'),
    1,
    'studio_domains: another studio may claim a pending hostname'
);

SELECT test_set_tenant('11111111-1111-4111-8111-111111111113', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin');

SELECT is(
    (SELECT count(*)::int FROM studio_domains),
    2,
    'studio_domains_admin_own: a member cannot delete the domains of their studio'
);

UPDATE studio_domains SET status = 'verified', verified_at = now() WHERE kind = 'web';

SELECT test_set_tenant('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'admin');

SELECT throws_ok(
    $$ UPDATE studio_domains SET status = 'verified', verified_at = now() WHERE kind = 'web' $$,
    '23505',
    NULL,
    'studio_domains_verified_hostname_unique: a hostname is verified for one studio only'
);

SELECT lives_ok(
    $$ DELETE FROM studio_domains WHERE kind = 'web' $$,
    'studio_domains_admin_own: an admin deletes a domain of their studio'
);

SELECT * FROM finish();
ROLLBACK;
