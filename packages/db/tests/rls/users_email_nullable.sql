-- =====================================================================
-- users_email_nullable.sql — RGPD purge under athlya_cron (issue #628)
--
-- Verifies that after migration 0041:
--   1. users.email is nullable.
--   2. The `anonymizeExpiredUsers` statement (packages/api/src/
--      maintenance/rgpd-purge.ts) runs as athlya_cron, with the same
--      `SET LOCAL ROLE athlya_cron` setup as cron_role.sql (the cron
--      connection carries no tenant claims), and anonymises every
--      expired soft-deleted user across studios.
--   3. Users soft-deleted inside the window and live users are left
--      untouched; a second pass is a no-op.
--   4. `users_email_live_check` confines NULL emails to soft-deleted
--      rows: a live user with a NULL email is rejected (23514), a purged
--      tombstone is accepted.
--   5. Readers tolerate the anonymised row: the login lookup and the
--      notification recipient never return it, the id lookup returns
--      it with a NULL email, and its old address can be registered
--      again.
--
-- Writes and their read-backs are separate statements (STABLE snapshot,
-- see CLAUDE.md pgTAP note).
-- =====================================================================

BEGIN;

INSERT INTO studios (id, name, slug, created_at)
VALUES
    ('cccccccc-cc41-4ccc-8ccc-cccccccc0041', 'Purge Studio A', 'purge-studio-a', NOW()),
    ('cccccccc-cc42-4ccc-8ccc-cccccccc0042', 'Purge Studio B', 'purge-studio-b', NOW());

INSERT INTO users (id, studio_id, email, display_name, avatar_url, password_hash, role, consents, deleted_at, created_at)
VALUES
    -- Expired soft-deleted users (one per studio).
    ('dddddddd-dd41-4ddd-8ddd-dddddddd0041', 'cccccccc-cc41-4ccc-8ccc-cccccccc0041',
     'expired-a@purge.test', 'Expired A', 'https://cdn.example.com/a.png', 'hash-a', 'member',
     '{"marketing":true,"analytics":true,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb,
     '2026-01-01 00:00:00+00', '2025-12-01 00:00:00+00'),
    ('dddddddd-dd42-4ddd-8ddd-dddddddd0042', 'cccccccc-cc42-4ccc-8ccc-cccccccc0042',
     'expired-b@purge.test', 'Expired B', NULL, 'hash-b', 'member',
     '{"marketing":false,"analytics":true,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb,
     NOW() - INTERVAL '31 days', NOW() - INTERVAL '60 days'),
    -- Soft-deleted inside the 30-day window: kept as is.
    ('dddddddd-dd43-4ddd-8ddd-dddddddd0043', 'cccccccc-cc41-4ccc-8ccc-cccccccc0041',
     'recent@purge.test', 'Recent', NULL, 'hash-c', 'member',
     '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb,
     NOW() - INTERVAL '10 days', NOW() - INTERVAL '60 days'),
    -- Live user: never touched.
    ('dddddddd-dd44-4ddd-8ddd-dddddddd0044', 'cccccccc-cc41-4ccc-8ccc-cccccccc0041',
     'live@purge.test', 'Live', NULL, 'hash-d', 'member',
     '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb,
     NULL, NOW() - INTERVAL '60 days');

SELECT plan(20);

SELECT col_is_null('users', 'email', 'users.email is nullable (0041)');

-- ------------------------------------------------------------------ --
-- Purge as athlya_cron: the statement anonymizeExpiredUsers sends,     --
-- with its $1 cutoff (now - 30 days) and $2 batch limit inlined.       --
-- ------------------------------------------------------------------ --
SET LOCAL ROLE athlya_cron;

SELECT results_eq(
    $$ WITH expired AS (
           SELECT id FROM users
           WHERE deleted_at IS NOT NULL
             AND deleted_at < NOW() - INTERVAL '30 days'
             AND email IS NOT NULL
           ORDER BY deleted_at ASC
           LIMIT 100
       ),
       anonymised AS (
           UPDATE users
           SET email = NULL,
               display_name = '[deleted]',
               avatar_url = NULL,
               consents = '{}'::jsonb,
               password_hash = NULL
           WHERE id IN (SELECT id FROM expired)
           RETURNING id
       )
       SELECT id FROM anonymised ORDER BY id $$,
    $$ VALUES ('dddddddd-dd41-4ddd-8ddd-dddddddd0041'::uuid),
              ('dddddddd-dd42-4ddd-8ddd-dddddddd0042'::uuid) $$,
    'athlya_cron anonymises every expired soft-deleted user across studios (no 23502)'
);

SELECT results_eq(
    $$ SELECT id, email, display_name, avatar_url, consents, password_hash
         FROM users
        WHERE id IN ('dddddddd-dd41-4ddd-8ddd-dddddddd0041', 'dddddddd-dd42-4ddd-8ddd-dddddddd0042')
        ORDER BY id $$,
    $$ VALUES
         ('dddddddd-dd41-4ddd-8ddd-dddddddd0041'::uuid, NULL::citext, '[deleted]'::text, NULL::text, '{}'::jsonb, NULL::text),
         ('dddddddd-dd42-4ddd-8ddd-dddddddd0042'::uuid, NULL::citext, '[deleted]'::text, NULL::text, '{}'::jsonb, NULL::text) $$,
    'expired users: email, avatar_url and password_hash are NULL, display_name is [deleted], consents are empty'
);

SELECT is(
    (SELECT deleted_at FROM users WHERE id = 'dddddddd-dd41-4ddd-8ddd-dddddddd0041'),
    '2026-01-01 00:00:00+00'::timestamptz,
    'the deleted_at tombstone is kept'
);

SELECT is(
    (SELECT email::text FROM users WHERE id = 'dddddddd-dd43-4ddd-8ddd-dddddddd0043'),
    'recent@purge.test',
    'a user soft-deleted inside the retention window keeps its email'
);

SELECT is(
    (SELECT display_name FROM users WHERE id = 'dddddddd-dd43-4ddd-8ddd-dddddddd0043'),
    'Recent',
    'a user soft-deleted inside the retention window keeps its display name'
);

SELECT is(
    (SELECT email::text FROM users WHERE id = 'dddddddd-dd44-4ddd-8ddd-dddddddd0044'),
    'live@purge.test',
    'a live user is never anonymised'
);

SELECT results_eq(
    $$ WITH expired AS (
           SELECT id FROM users
           WHERE deleted_at IS NOT NULL
             AND deleted_at < NOW() - INTERVAL '30 days'
             AND email IS NOT NULL
           ORDER BY deleted_at ASC
           LIMIT 100
       ),
       anonymised AS (
           UPDATE users
           SET email = NULL,
               display_name = '[deleted]',
               avatar_url = NULL,
               consents = '{}'::jsonb,
               password_hash = NULL
           WHERE id IN (SELECT id FROM expired)
           RETURNING id
       )
       SELECT count(*)::int FROM anonymised $$,
    $$ VALUES (0) $$,
    'a second purge pass is a no-op (email IS NOT NULL guard)'
);

RESET ROLE;

SELECT is(
    (SELECT email::text FROM users WHERE id = 'dddddddd-dd42-4ddd-8ddd-dddddddd0042'),
    NULL,
    'the anonymised email reads back as NULL outside the cron role'
);

-- ------------------------------------------------------------------ --
-- Readers (SECURITY DEFINER, called as athlya_app without claims).    --
-- ------------------------------------------------------------------ --
SET LOCAL ROLE athlya_app;

SELECT is(
    (SELECT count(*)::int FROM auth_find_active_user_by_email('expired-a@purge.test')),
    0,
    'login lookup: the old address of an anonymised user matches nothing'
);

SELECT is(
    (SELECT count(*)::int FROM auth_find_active_user_by_email('live@purge.test')),
    1,
    'login lookup: a live user is still found'
);

SELECT is(
    (SELECT count(*)::int FROM notification_recipient('dddddddd-dd41-4ddd-8ddd-dddddddd0041')),
    0,
    'notification_recipient: an anonymised user is never a recipient'
);

SELECT results_eq(
    $$ SELECT email, deleted_at IS NOT NULL
         FROM auth_find_user_by_id('dddddddd-dd41-4ddd-8ddd-dddddddd0041') $$,
    $$ VALUES (NULL::text, true) $$,
    'auth_find_user_by_id returns the tombstone with a NULL email (the adapter maps it to not found)'
);

RESET ROLE;

-- ------------------------------------------------------------------ --
-- Uniqueness: the partial index (0026) and NULL emails.               --
-- ------------------------------------------------------------------ --
SELECT lives_ok(
    $$ INSERT INTO users (id, studio_id, email, display_name, role, consents)
       VALUES ('dddddddd-dd45-4ddd-8ddd-dddddddd0045', 'cccccccc-cc41-4ccc-8ccc-cccccccc0041',
               'expired-a@purge.test', 'Back Again', 'member',
               '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb) $$,
    'the address of an anonymised user can be registered again'
);

SELECT throws_ok(
    $$ INSERT INTO users (id, studio_id, email, display_name, role, consents)
       VALUES ('dddddddd-dd46-4ddd-8ddd-dddddddd0046', 'cccccccc-cc41-4ccc-8ccc-cccccccc0041',
               'LIVE@purge.test', 'Duplicate', 'member',
               '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb) $$,
    '23505',
    NULL,
    'users_email_active_unique still rejects a duplicate live email'
);

SELECT is(
    (SELECT count(*)::int FROM users WHERE email IS NULL AND id IN (
        'dddddddd-dd41-4ddd-8ddd-dddddddd0041', 'dddddddd-dd42-4ddd-8ddd-dddddddd0042')),
    2,
    'several anonymised users coexist with a NULL email'
);

-- ------------------------------------------------------------------ --
-- users_email_live_check: NULL only on soft-deleted rows.             --
-- ------------------------------------------------------------------ --
SELECT throws_ok(
    $$ INSERT INTO users (id, studio_id, email, display_name, role, consents)
       VALUES ('dddddddd-dd47-4ddd-8ddd-dddddddd0047', 'cccccccc-cc41-4ccc-8ccc-cccccccc0041',
               NULL, 'No Email', 'member',
               '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb) $$,
    '23514',
    NULL,
    'a live user with a NULL email is rejected (users_email_live_check)'
);

SELECT throws_ok(
    $$ SELECT * FROM auth_create_member('cccccccc-cc41-4ccc-8ccc-cccccccc0041', NULL, 'No Email', 'hash',
           '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb) $$,
    '23514',
    NULL,
    'auth_create_member cannot create a live member without an email'
);

SELECT lives_ok(
    $$ INSERT INTO users (id, studio_id, email, display_name, role, consents, deleted_at)
       VALUES ('dddddddd-dd48-4ddd-8ddd-dddddddd0048', 'cccccccc-cc41-4ccc-8ccc-cccccccc0041',
               NULL, '[deleted]', 'member', '{}'::jsonb, NOW() - INTERVAL '40 days') $$,
    'a purged tombstone (soft-deleted, NULL email) is accepted'
);

SELECT throws_ok(
    $$ UPDATE users SET deleted_at = NULL WHERE id = 'dddddddd-dd41-4ddd-8ddd-dddddddd0041' $$,
    '23514',
    NULL,
    'an anonymised tombstone cannot be restored to a live user without an email'
);

SELECT * FROM finish();
ROLLBACK;
