-- =====================================================================
-- auth_password_reset_outbox.sql — migration 0043 under the real
-- athlya_app role (issue #645)
--
-- Asserts that, without tenant GUCs:
--   - `auth_request_password_reset` records one
--     `auth.password_reset.requested` row for a live account (case-
--     insensitive match), carrying only the account id and its studio;
--   - an unknown or soft-deleted address records nothing;
--   - a missing event id is refused;
--   - the function is SECURITY DEFINER, owned by athlya_owner, with a
--     pinned search_path and EXECUTE for athlya_app only.
--
-- Writes and their read-backs are separate statements (STABLE snapshot,
-- see CLAUDE.md pgTAP note).
-- =====================================================================

BEGIN;
SELECT plan(15);

UPDATE users SET deleted_at = now() WHERE id = '11111111-1111-4111-8111-111111111112';

SELECT ok(
    (SELECT bool_and(
                p.prosecdef
            AND pg_get_userbyid(p.proowner) = 'athlya_owner'
            AND 'search_path=public, pg_temp' = ANY (p.proconfig)
            AND has_function_privilege('athlya_app', p.oid, 'EXECUTE')
            AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
            AND NOT has_function_privilege('athlya_cron', p.oid, 'EXECUTE'))
       FROM pg_proc p
      WHERE p.oid IN ('auth_request_password_reset(text, uuid)'::regprocedure,
                      'auth_issue_password_reset_for_request(uuid, text, timestamptz)'::regprocedure)),
    '0043 functions: SECURITY DEFINER, athlya_owner, pinned search_path, athlya_app only'
);

SET LOCAL ROLE athlya_app;

SELECT is(
    auth_request_password_reset('Member-A@Athlya.Test', '0193f000-0000-7000-8000-000000000645'),
    true,
    'auth_request_password_reset: records a request for a live account (citext match)'
);

SELECT is(
    auth_request_password_reset('nobody@athlya.test', '0193f000-0000-7000-8000-000000000646'),
    false,
    'auth_request_password_reset: records nothing for an unknown address'
);

SELECT is(
    auth_request_password_reset('member-a2@athlya.test', '0193f000-0000-7000-8000-000000000647'),
    false,
    'auth_request_password_reset: records nothing for a soft-deleted account'
);

SELECT throws_ok(
    $$ SELECT auth_request_password_reset('member-a@athlya.test', NULL) $$,
    '22023',
    NULL,
    'auth_request_password_reset: refuses a missing event id'
);

RESET ROLE;

SELECT results_eq(
    $$ SELECT event_type, studio_id, payload, published_at IS NULL
         FROM outbox WHERE event_id = '0193f000-0000-7000-8000-000000000645' $$,
    $$ VALUES ('auth.password_reset.requested'::text, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
               jsonb_build_object('userId', '11111111-1111-4111-8111-111111111111'), true) $$,
    'the outbox row carries the account id only, pending'
);

SELECT is(
    (SELECT count(*)::int FROM outbox
      WHERE event_id IN ('0193f000-0000-7000-8000-000000000646',
                         '0193f000-0000-7000-8000-000000000647')),
    0,
    'no outbox row for the unknown or soft-deleted address'
);

SELECT is(
    (SELECT count(*)::int FROM outbox
      WHERE event_type = 'auth.password_reset.requested'
        AND (payload::text ILIKE '%@%' OR payload ? 'token')),
    0,
    'no password-reset outbox row holds an email address or a token'
);

-- ---------- per-request token issuance ----------

SET LOCAL ROLE athlya_app;

SELECT is(
    auth_issue_password_reset_for_request('11111111-1111-4111-8111-111111111113', 'req-token-1', now() + interval '1 hour'),
    'issued',
    'auth_issue_password_reset_for_request: issues the request token'
);

SELECT is(
    auth_issue_password_reset_for_request('11111111-1111-4111-8111-111111111113', 'req-token-1', now() + interval '2 hours'),
    'issued',
    'auth_issue_password_reset_for_request: a retry finds its own token instead of invalidating it'
);

SELECT is(
    (SELECT user_id FROM auth_find_password_reset('req-token-1')),
    '11111111-1111-4111-8111-111111111113'::uuid,
    'auth_issue_password_reset_for_request: the retried token is still active'
);

SELECT is(
    auth_issue_password_reset_for_request('11111111-1111-4111-8111-111111111113', 'req-token-2', now() + interval '1 hour'),
    'issued',
    'auth_issue_password_reset_for_request: a later request issues its own token'
);

SELECT is(
    auth_issue_password_reset_for_request('11111111-1111-4111-8111-111111111113', 'req-token-1', now() + interval '1 hour'),
    'superseded',
    'auth_issue_password_reset_for_request: a retry of the earlier request is superseded'
);

SELECT is(
    auth_issue_password_reset_for_request('11111111-1111-4111-8111-111111111112', 'req-token-3', now() + interval '1 hour'),
    'inactive',
    'auth_issue_password_reset_for_request: nothing for a soft-deleted account'
);

SELECT throws_ok(
    $$ SELECT auth_issue_password_reset_for_request('11111111-1111-4111-8111-111111111111', 'req-token-2', now() + interval '1 hour') $$,
    '22023',
    NULL,
    'auth_issue_password_reset_for_request: refuses a hash owned by another user'
);

SELECT * FROM finish();
ROLLBACK;
