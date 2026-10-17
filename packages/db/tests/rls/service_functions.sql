-- =====================================================================
-- service_functions.sql — SECURITY DEFINER service contracts (issue #224)
--
-- Runs as the real `athlya_app` role (NOBYPASSRLS) with NO tenant GUCs,
-- which is exactly the posture of the pre-auth auth routes and of the
-- notifications / RGPD cascade queue consumers. Asserts that:
--   - raw table access still sees nothing (FORCE RLS backstop holds);
--   - each migration-0032 function does its one job;
--   - the RGPD functions are no-ops for a live account;
--   - EXECUTE is not granted to PUBLIC.
-- =====================================================================

BEGIN;
SELECT plan(27);

SET LOCAL ROLE athlya_app;

-- ---------- RLS backstop without claims ----------

SELECT is(
    (SELECT count(*)::int FROM users),
    0,
    'athlya_app without tenant GUCs reads zero users rows directly'
);

-- ---------- pre-auth lookups ----------

SELECT is(
    (SELECT id FROM auth_find_active_user_by_email('MEMBER-A@athlya.test')),
    '11111111-1111-4111-8111-111111111111'::uuid,
    'auth_find_active_user_by_email: case-insensitive (citext) match'
);

SELECT is(
    (SELECT role FROM auth_find_user_by_id('22222222-2222-4222-8222-222222222222')),
    'admin',
    'auth_find_user_by_id: returns the row across studios'
);

SELECT results_eq(
    $$ SELECT id, slug, name FROM auth_find_studio_by_slug('studio-b') $$,
    $$ VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid, 'studio-b'::text, 'Studio Bravo'::text) $$,
    'auth_find_studio_by_slug: resolves a studio without tenant context'
);

SELECT is_empty(
    $$ SELECT * FROM auth_find_studio_by_slug('no-such-studio') $$,
    'auth_find_studio_by_slug: unknown slug returns no row'
);

-- ---------- registration ----------

SELECT is(
    (SELECT role FROM auth_create_member(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'new-member@athlya.test', 'New Member',
        'hash', '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb)),
    'member',
    'auth_create_member: creates a member account'
);

SELECT throws_ok(
    $$ SELECT * FROM auth_create_member(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Member-A@athlya.test', 'Dup', 'hash', '{}'::jsonb) $$,
    '23505',
    NULL,
    'auth_create_member: duplicate active email raises unique_violation'
);

SELECT throws_ok(
    $$ SELECT * FROM auth_create_member(
        'ffffffff-0000-4000-8000-000000000000', 'ghost@athlya.test', 'Ghost', 'hash', '{}'::jsonb) $$,
    '23503',
    NULL,
    'auth_create_member: unknown studio raises foreign_key_violation'
);

-- ---------- credentials ----------

SELECT auth_bump_credentials_version('11111111-1111-4111-8111-111111111112');

SELECT is(
    (SELECT credentials_version FROM auth_find_user_by_id('11111111-1111-4111-8111-111111111112')),
    2,
    'auth_bump_credentials_version: increments the counter'
);

-- ---------- password reset ----------

RESET ROLE;
INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES
    ('a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a001', '11111111-1111-4111-8111-111111111114', 'svc-reset-hash', now() + interval '1 hour');
SET LOCAL ROLE athlya_app;

SELECT is(
    (SELECT * FROM auth_consume_password_reset('svc-reset-hash', '11111111-1111-4111-8111-111111111111', 'new-hash')),
    NULL,
    'auth_consume_password_reset: a token presented for another user changes nothing'
);

SELECT is(
    (SELECT * FROM auth_consume_password_reset('svc-reset-hash', '11111111-1111-4111-8111-111111111114', 'new-hash')),
    '11111111-1111-4111-8111-111111111114'::uuid,
    'auth_consume_password_reset: consumes the token and rotates the password'
);

SELECT results_eq(
    $$ SELECT password_hash, credentials_version FROM auth_find_user_by_id('11111111-1111-4111-8111-111111111114') $$,
    $$ VALUES ('new-hash'::text, 2) $$,
    'auth_consume_password_reset: password_hash rotated and credentials_version bumped'
);

SELECT is_empty(
    $$ SELECT * FROM auth_consume_password_reset('svc-reset-hash', '11111111-1111-4111-8111-111111111114', 'again') $$,
    'auth_consume_password_reset: a consumed token cannot be replayed'
);

-- Issue #609: an expired token is refused at the SQL layer too.
RESET ROLE;
INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES
    ('a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a002', '11111111-1111-4111-8111-111111111114', 'svc-expired-hash', now() - interval '1 second');
SET LOCAL ROLE athlya_app;

SELECT is_empty(
    $$ SELECT * FROM auth_consume_password_reset('svc-expired-hash', '11111111-1111-4111-8111-111111111114', 'expired') $$,
    'auth_consume_password_reset: an expired token is not consumed'
);

SELECT results_eq(
    $$ SELECT password_hash, credentials_version FROM auth_find_user_by_id('11111111-1111-4111-8111-111111111114') $$,
    $$ VALUES ('new-hash'::text, 2) $$,
    'auth_consume_password_reset: an expired token leaves the password untouched'
);

-- ---------- notifications ----------

SELECT results_eq(
    $$ SELECT id, email, push_tokens FROM notification_recipient('11111111-1111-4111-8111-111111111111') $$,
    $$ VALUES ('11111111-1111-4111-8111-111111111111'::uuid, 'member-a@athlya.test'::text, ARRAY['token-seed-a']::text[]) $$,
    'notification_recipient: email and active push tokens of the recipient'
);

-- ---------- RGPD cascade: live account is protected ----------

SELECT is(
    rgpd_delete_reservations('22222222-2222-4222-8222-222222222221')
      + rgpd_delete_workout_sessions('22222222-2222-4222-8222-222222222221')
      + rgpd_delete_push_tokens('22222222-2222-4222-8222-222222222221')
      + rgpd_delete_idempotency_keys('22222222-2222-4222-8222-222222222221'),
    0,
    'rgpd_delete_*: no-op for an account that is not soft-deleted'
);

SELECT rgpd_restamp_user_deleted('22222222-2222-4222-8222-222222222221', now());

SELECT is(
    (SELECT deleted_at FROM auth_find_user_by_id('22222222-2222-4222-8222-222222222221')),
    NULL,
    'rgpd_restamp_user_deleted: never tombstones a live account'
);

SELECT is(
    rgpd_confirm_user_deleted('22222222-2222-4222-8222-222222222221', now()),
    false,
    'rgpd_confirm_user_deleted: reports a live account as not deleted'
);

SELECT is(
    (SELECT deleted_at FROM auth_find_user_by_id('22222222-2222-4222-8222-222222222221')),
    NULL,
    'rgpd_confirm_user_deleted: never tombstones a live account'
);

-- ---------- RGPD cascade: deleted account ----------

SELECT auth_soft_delete_user('22222222-2222-4222-8222-222222222221');

SELECT is_empty(
    $$ SELECT * FROM auth_find_active_user_by_email('member-b@athlya.test') $$,
    'auth_soft_delete_user: account no longer resolves for login'
);

SELECT is_empty(
    $$ SELECT * FROM notification_recipient('22222222-2222-4222-8222-222222222221') $$,
    'notification_recipient: a deleted account has no recipient'
);

SELECT is(
    ARRAY[
        rgpd_delete_reservations('22222222-2222-4222-8222-222222222221'),
        rgpd_delete_workout_sessions('22222222-2222-4222-8222-222222222221'),
        rgpd_delete_push_tokens('22222222-2222-4222-8222-222222222221'),
        rgpd_delete_idempotency_keys('22222222-2222-4222-8222-222222222221')
    ],
    ARRAY[1, 1, 1, 1],
    'rgpd_delete_*: purge the rows of a soft-deleted user'
);

SELECT is(
    rgpd_delete_reservations('22222222-2222-4222-8222-222222222221'),
    0,
    'rgpd_delete_*: idempotent on replay'
);

SELECT is(
    rgpd_confirm_user_deleted('22222222-2222-4222-8222-222222222221', now()),
    true,
    'rgpd_confirm_user_deleted: reports a soft-deleted account'
);

RESET ROLE;

-- ---------- privileges ----------

SELECT is(
    (SELECT count(*)::int FROM pg_proc p
      WHERE p.proname IN (
          'auth_find_active_user_by_email', 'auth_find_user_by_id', 'auth_find_studio_by_slug',
          'auth_create_member', 'auth_soft_delete_user', 'auth_bump_credentials_version',
          'auth_consume_password_reset', 'notification_recipient', 'rgpd_delete_reservations',
          'rgpd_delete_workout_sessions', 'rgpd_delete_push_tokens', 'rgpd_delete_idempotency_keys',
          'rgpd_restamp_user_deleted', 'rgpd_confirm_user_deleted')
        AND p.prosecdef
        AND pg_get_userbyid(p.proowner) = 'athlya_owner'
        AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
        AND 'search_path=public, pg_temp' = ANY (p.proconfig)),
    14,
    'all 14 service functions: SECURITY DEFINER, owned by athlya_owner, pinned search_path, no PUBLIC EXECUTE'
);

SELECT ok(
    has_function_privilege('athlya_app', 'auth_find_user_by_id(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('athlya_cron', 'auth_find_user_by_id(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('athlya_cron', 'rgpd_delete_reservations(uuid)', 'EXECUTE')
    AND has_function_privilege('athlya_app', 'rgpd_confirm_user_deleted(uuid, timestamptz)', 'EXECUTE')
    AND NOT has_function_privilege('athlya_cron', 'rgpd_confirm_user_deleted(uuid, timestamptz)', 'EXECUTE'),
    'service functions are granted to athlya_app, not to athlya_cron'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
