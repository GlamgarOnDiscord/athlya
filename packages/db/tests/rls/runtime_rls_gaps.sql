-- =====================================================================
-- runtime_rls_gaps.sql — migration 0039 under the real athlya_app role
-- (issue #117)
--
-- Asserts that, without tenant GUCs:
--   - athlya_app cannot write `password_reset_tokens` directly, but
--     `auth_issue_password_reset` issues a token (invalidating the
--     previous one), refuses an out-of-range TTL and a deleted user;
--   - `auth_find_password_reset` only returns active tokens;
--   - a raw UPDATE of `audit_log` is refused, and
--     `rgpd_anonymize_user_audit` is a no-op for a live user and
--     anonymises a soft-deleted user's rows;
--   - the three functions are SECURITY DEFINER, owned by athlya_owner,
--     with a pinned search_path and no PUBLIC / athlya_cron EXECUTE.
--
-- Writes and their read-backs are separate statements (STABLE snapshot,
-- see CLAUDE.md pgTAP note).
-- =====================================================================

BEGIN;
SELECT plan(19);

-- Seed as the migration superuser: an audit row for a live member and
-- for a member about to be deleted, plus a soft-deleted user.
INSERT INTO audit_log (actor_id, action, metadata) VALUES
    ('11111111-1111-4111-8111-111111111111', 'gaps.live', '{"email":"member-a@athlya.test","keep":"x"}'::jsonb),
    ('11111111-1111-4111-8111-111111111112', 'gaps.deleted', '{"email":"member-a2@athlya.test","keep":"y"}'::jsonb);
UPDATE users SET deleted_at = now() WHERE id = '11111111-1111-4111-8111-111111111112';
INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
VALUES ('11111111-1111-4111-8111-111111111113', 'gaps-token-expired', now() - interval '1 minute');

-- ---------- hardening ----------

SELECT ok(
    (SELECT bool_and(
                p.prosecdef
            AND pg_get_userbyid(p.proowner) = 'athlya_owner'
            AND 'search_path=public, pg_temp' = ANY (p.proconfig)
            AND has_function_privilege('athlya_app', p.oid, 'EXECUTE')
            AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
            AND NOT has_function_privilege('athlya_cron', p.oid, 'EXECUTE'))
       FROM pg_proc p
      WHERE p.oid IN ('auth_issue_password_reset(uuid, text, timestamptz)'::regprocedure,
                      'auth_find_password_reset(text)'::regprocedure,
                      'rgpd_anonymize_user_audit(uuid)'::regprocedure)),
    '0039 functions: SECURITY DEFINER, athlya_owner, pinned search_path, athlya_app only'
);

SET LOCAL ROLE athlya_app;

-- ---------- password reset ----------

SELECT throws_ok(
    $$ INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ('11111111-1111-4111-8111-111111111111', 'raw-insert', now() + interval '1 hour') $$,
    '42501',
    NULL,
    'athlya_app cannot insert password_reset_tokens directly'
);

SELECT is(
    auth_issue_password_reset('11111111-1111-4111-8111-111111111111', 'gaps-token-1', now() + interval '1 hour'),
    true,
    'auth_issue_password_reset: issues a token for a live user'
);

SELECT is(
    (SELECT user_id FROM auth_find_password_reset('gaps-token-1')),
    '11111111-1111-4111-8111-111111111111'::uuid,
    'auth_find_password_reset: finds the active token'
);

SELECT is_empty(
    $$ SELECT * FROM auth_find_password_reset('gaps-token-expired') $$,
    'auth_find_password_reset: an expired, unconsumed token is not returned'
);

SELECT is(
    auth_issue_password_reset('11111111-1111-4111-8111-111111111111', 'gaps-token-2', now() + interval '1 hour'),
    true,
    'auth_issue_password_reset: a second request issues a new token'
);

SELECT is_empty(
    $$ SELECT * FROM auth_find_password_reset('gaps-token-1') $$,
    'auth_issue_password_reset: the previous active token is invalidated (issue #522)'
);

SELECT is(
    (SELECT user_id FROM auth_find_password_reset('gaps-token-2')),
    '11111111-1111-4111-8111-111111111111'::uuid,
    'auth_find_password_reset: the latest token is active'
);

SELECT is(
    auth_issue_password_reset('11111111-1111-4111-8111-111111111112', 'gaps-token-deleted', now() + interval '1 hour'),
    false,
    'auth_issue_password_reset: issues nothing for a soft-deleted user'
);

SELECT is_empty(
    $$ SELECT * FROM auth_find_password_reset('gaps-token-deleted') $$,
    'auth_issue_password_reset: no token row for a soft-deleted user'
);

SELECT throws_ok(
    $$ SELECT auth_issue_password_reset('11111111-1111-4111-8111-111111111111', 'gaps-token-long', now() + interval '25 hours') $$,
    '22023',
    NULL,
    'auth_issue_password_reset: refuses a TTL above 24 hours'
);

SELECT throws_ok(
    $$ SELECT auth_issue_password_reset('11111111-1111-4111-8111-111111111111', 'gaps-token-past', now() - interval '1 minute') $$,
    '22023',
    NULL,
    'auth_issue_password_reset: refuses an already-expired token'
);

SELECT is(
    (SELECT count(*)::int FROM auth_consume_password_reset('gaps-token-2', '11111111-1111-4111-8111-111111111111', 'new-hash')),
    1,
    'auth_consume_password_reset: consumes the issued token'
);

SELECT is_empty(
    $$ SELECT * FROM auth_find_password_reset('gaps-token-2') $$,
    'auth_find_password_reset: a consumed token is no longer active'
);

-- ---------- RGPD audit anonymisation ----------

SELECT throws_ok(
    $$ UPDATE audit_log SET actor_id = NULL WHERE action = 'gaps.deleted' $$,
    '42501',
    NULL,
    'athlya_app cannot UPDATE audit_log directly'
);

SELECT is(
    rgpd_anonymize_user_audit('11111111-1111-4111-8111-111111111111'),
    0,
    'rgpd_anonymize_user_audit: no-op for a live user'
);

SELECT ok(
    rgpd_anonymize_user_audit('11111111-1111-4111-8111-111111111112') >= 1,
    'rgpd_anonymize_user_audit: anonymises the rows of a soft-deleted user'
);

SELECT is(
    rgpd_anonymize_user_audit('11111111-1111-4111-8111-111111111112'),
    0,
    'rgpd_anonymize_user_audit: a replay anonymises (and reports) nothing'
);

RESET ROLE;

SELECT results_eq(
    $$ SELECT action, actor_id, metadata FROM audit_log
        WHERE action IN ('gaps.live', 'gaps.deleted') ORDER BY action $$,
    $$ VALUES
        ('gaps.deleted'::text, NULL::uuid, '{"keep":"y"}'::jsonb),
        ('gaps.live'::text, '11111111-1111-4111-8111-111111111111'::uuid,
         '{"email":"member-a@athlya.test","keep":"x"}'::jsonb) $$,
    'audit rows: deleted user anonymised (actor + PII stripped), live user untouched'
);

SELECT * FROM finish();
ROLLBACK;
