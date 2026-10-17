-- =====================================================================
-- auth_event_recording.sql — atomic auth outbox recording (issue #411)
--
-- Runs as the real `athlya_app` role with no tenant GUCs (the auth
-- routes' posture). Asserts that the compliance-critical auth events
-- commit with their user mutation, that a bad envelope rolls the
-- mutation back, and that `auth_record_event` only takes advisory types.
-- =====================================================================

BEGIN;
SELECT plan(14);

SET LOCAL ROLE athlya_app;

-- ---------- registration + auth.user.registered ----------

SELECT is(
    (SELECT role FROM auth_create_member_with_event(
        '0193f000-0000-7000-8000-000000000411', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'evt-411-register@athlya.test', 'Evt 411', 'hash', '{}'::jsonb,
        jsonb_build_object(
            'id', 'evt-411-registered', 'type', 'auth.user.registered',
            'occurredAt', '2026-10-12T00:00:00Z', 'studioId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'payload', jsonb_build_object('userId', '0193f000-0000-7000-8000-000000000411')))),
    'member',
    'auth_create_member_with_event: creates the member'
);

RESET ROLE;
SELECT results_eq(
    $$ SELECT event_type, studio_id, payload->'payload'->>'userId', published_at IS NULL, attempts
         FROM outbox WHERE event_id = 'evt-411-registered' $$,
    $$ VALUES ('auth.user.registered'::text, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
               '0193f000-0000-7000-8000-000000000411'::text, true, 0) $$,
    'auth_create_member_with_event: the registered event is in the outbox, pending'
);
SET LOCAL ROLE athlya_app;

SELECT throws_ok(
    $$ SELECT * FROM auth_create_member_with_event(
        '0193f000-0000-7000-8000-000000000412', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'evt-412@athlya.test', 'Evt 412', 'hash', '{}'::jsonb,
        jsonb_build_object(
            'id', 'evt-412', 'type', 'auth.user.registered', 'occurredAt', '2026-10-12T00:00:00Z',
            'studioId', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            'payload', jsonb_build_object('userId', '0193f000-0000-7000-8000-000000000412'))) $$,
    '22023',
    NULL,
    'auth_create_member_with_event: envelope for another studio is refused'
);

SELECT is_empty(
    $$ SELECT * FROM auth_find_user_by_id('0193f000-0000-7000-8000-000000000412') $$,
    'auth_create_member_with_event: a refused envelope leaves no user behind'
);

SELECT throws_ok(
    $$ SELECT * FROM auth_create_member_with_event(
        '0193f000-0000-7000-8000-000000000413', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'evt-413@athlya.test', 'Evt 413', 'hash', '{}'::jsonb,
        jsonb_build_object(
            'id', 'evt-413', 'type', 'auth.user.deleted', 'occurredAt', '2026-10-12T00:00:00Z',
            'studioId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'payload', jsonb_build_object('userId', '0193f000-0000-7000-8000-000000000413'))) $$,
    '22023',
    NULL,
    'auth_create_member_with_event: only auth.user.registered may be recorded'
);

-- ---------- deletion + auth.user.deleted ----------

SELECT throws_ok(
    $$ SELECT auth_soft_delete_user_with_event('11111111-1111-4111-8111-111111111112',
        jsonb_build_object(
            'id', 'evt-411-bad-delete', 'type', 'auth.user.deleted', 'occurredAt', '2026-10-12T00:00:00Z',
            'studioId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'payload', jsonb_build_object('userId', '11111111-1111-4111-8111-111111111111'))) $$,
    '22023',
    NULL,
    'auth_soft_delete_user_with_event: envelope for another user is refused'
);

SELECT is(
    (SELECT deleted_at FROM auth_find_user_by_id('11111111-1111-4111-8111-111111111112')),
    NULL,
    'auth_soft_delete_user_with_event: a refused envelope rolls the soft delete back'
);

SELECT lives_ok(
    $$ SELECT auth_soft_delete_user_with_event('11111111-1111-4111-8111-111111111112',
        jsonb_build_object(
            'id', 'evt-411-deleted', 'type', 'auth.user.deleted', 'occurredAt', '2026-10-12T00:00:00Z',
            'studioId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'payload', jsonb_build_object('userId', '11111111-1111-4111-8111-111111111112'))) $$,
    'auth_soft_delete_user_with_event: deletes and records atomically'
);

SELECT isnt(
    (SELECT deleted_at FROM auth_find_user_by_id('11111111-1111-4111-8111-111111111112')),
    NULL,
    'auth_soft_delete_user_with_event: the account is tombstoned'
);

RESET ROLE;
SELECT is(
    (SELECT count(*)::int FROM outbox WHERE event_id = 'evt-411-deleted' AND event_type = 'auth.user.deleted'),
    1,
    'auth_soft_delete_user_with_event: the deleted event is in the outbox'
);
SET LOCAL ROLE athlya_app;

SELECT throws_ok(
    $$ SELECT auth_soft_delete_user_with_event('0193f000-0000-7000-8000-0000000004ff',
        jsonb_build_object(
            'id', 'evt-411-ghost', 'type', 'auth.user.deleted', 'occurredAt', '2026-10-12T00:00:00Z',
            'studioId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'payload', jsonb_build_object('userId', '0193f000-0000-7000-8000-0000000004ff'))) $$,
    'P0002',
    NULL,
    'auth_soft_delete_user_with_event: unknown user raises no_data_found'
);

-- ---------- advisory events ----------

SELECT lives_ok(
    $$ SELECT auth_record_event(jsonb_build_object(
        'id', 'evt-411-anomaly', 'type', 'auth.suspicious.login.anomaly',
        'occurredAt', '2026-10-12T00:00:00Z', 'studioId', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'payload', '{}'::jsonb)) $$,
    'auth_record_event: records an advisory auth event without tenant context'
);

SELECT throws_ok(
    $$ SELECT auth_record_event(jsonb_build_object(
        'id', 'evt-411-forged', 'type', 'auth.user.deleted',
        'occurredAt', '2026-10-12T00:00:00Z', 'studioId', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'payload', jsonb_build_object('userId', '22222222-2222-4222-8222-222222222221'))) $$,
    '22023',
    NULL,
    'auth_record_event: refuses auth.user.* (only emitted with their mutation)'
);

RESET ROLE;

SELECT ok(
    NOT has_function_privilege('athlya_app', 'auth_outbox_insert(jsonb, text[])', 'EXECUTE')
    AND has_function_privilege('athlya_app', 'auth_record_event(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('athlya_cron', 'auth_record_event(jsonb)', 'EXECUTE'),
    'auth_outbox_insert is internal; recording functions are granted to athlya_app only'
);

SELECT * FROM finish();
ROLLBACK;
