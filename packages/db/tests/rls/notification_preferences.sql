-- =====================================================================
-- notification_preferences.sql: member notification preferences
-- (migration 0054, issue #762)
--
-- Asserts that:
--   - `notification_preferences_of` is locked down (SECURITY DEFINER,
--     athlya_owner, pinned search_path, no PUBLIC, no athlya_cron);
--   - a member writes their own preferences under athlya_app and
--     `users_update_own` keeps them off another member's row;
--   - the CHECK refuses anything but a JSON object;
--   - the function returns `{}` without preferences, the stored object
--     otherwise, and nothing for a deleted or unknown user.
--
-- Writes and their read-backs are separate statements: `app_user_id()`
-- is STABLE (see CLAUDE.md, pgTAP note).
-- =====================================================================

BEGIN;
SELECT plan(12);

SELECT ok(
    (SELECT prosecdef FROM pg_proc WHERE oid = 'notification_preferences_of(uuid)'::regprocedure),
    'notification_preferences_of: SECURITY DEFINER'
);

SELECT is(
    (SELECT pg_get_userbyid(proowner)::text FROM pg_proc
      WHERE oid = 'notification_preferences_of(uuid)'::regprocedure),
    'athlya_owner',
    'notification_preferences_of: owned by athlya_owner'
);

SELECT ok(
    (SELECT 'search_path=public, pg_temp' = ANY (proconfig)
       FROM pg_proc WHERE oid = 'notification_preferences_of(uuid)'::regprocedure),
    'notification_preferences_of: search_path pinned to public, pg_temp'
);

SELECT ok(
    NOT has_function_privilege('public', 'notification_preferences_of(uuid)', 'EXECUTE'),
    'notification_preferences_of: EXECUTE not granted to PUBLIC'
);

SELECT ok(
    NOT has_function_privilege('athlya_cron', 'notification_preferences_of(uuid)', 'EXECUTE'),
    'notification_preferences_of: EXECUTE not granted to athlya_cron'
);

SET LOCAL ROLE athlya_app;

SELECT is(
    notification_preferences_of('11111111-1111-4111-8111-111111111111'),
    '{}'::jsonb,
    'notification_preferences_of: {} for a member without preferences'
);

-- ---------- a member writes their own row ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member');

UPDATE users
   SET notification_preferences = '{"reservationCreated":{"email":false}}'::jsonb
 WHERE id = '11111111-1111-4111-8111-111111111111';

SELECT is(
    (SELECT notification_preferences FROM users WHERE id = '11111111-1111-4111-8111-111111111111'),
    '{"reservationCreated":{"email":false}}'::jsonb,
    'users_update_own: a member stores their notification preferences'
);

UPDATE users
   SET notification_preferences = '{"reservationReminder":{"push":false}}'::jsonb
 WHERE id = '11111111-1111-4111-8111-111111111112';

SELECT throws_ok(
    $$ UPDATE users SET notification_preferences = '[]'::jsonb
        WHERE id = '11111111-1111-4111-8111-111111111111' $$,
    '23514',
    NULL,
    'users_notification_preferences_object_check: refuses a JSON array'
);

SELECT test_unset_tenant();

SELECT is(
    notification_preferences_of('11111111-1111-4111-8111-111111111112'),
    '{}'::jsonb,
    'users_update_own: a member cannot write another member''s preferences'
);

SELECT is(
    notification_preferences_of('11111111-1111-4111-8111-111111111111'),
    '{"reservationCreated":{"email":false}}'::jsonb,
    'notification_preferences_of: returns the stored preferences without tenant claims'
);

SELECT is(
    notification_preferences_of('00000000-0000-4000-8000-000000000000'),
    NULL::jsonb,
    'notification_preferences_of: NULL for an unknown user'
);

RESET ROLE;
UPDATE users SET deleted_at = now() WHERE id = '11111111-1111-4111-8111-111111111111';
SET LOCAL ROLE athlya_app;

SELECT is(
    notification_preferences_of('11111111-1111-4111-8111-111111111111'),
    NULL::jsonb,
    'notification_preferences_of: NULL for a deleted user'
);

SELECT * FROM finish();
ROLLBACK;
