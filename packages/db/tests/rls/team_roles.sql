-- =====================================================================
-- team_roles.sql: migration 0052 under the real athlya_app role
-- (issue #756)
--
-- Asserts that:
--   - the four team functions and the check-in function are SECURITY
--     DEFINER, owned by athlya_owner, with a pinned search_path and
--     EXECUTE for athlya_app only;
--   - a manager reads the studio's members, reservations, audit log and
--     invitations, writes classes and programs, but cannot write another
--     user's row nor change the team;
--   - a front desk (accueil) reads members and reservations, checks a
--     member in, and writes nothing else;
--   - only an admin invites, changes a role and revokes an invitation,
--     never their own role, never across studios;
--   - an invitation is accepted once, by the invited account only;
--   - athlya_app cannot read an invitation's token digest.
--
-- Writes and their read-backs are separate statements (STABLE snapshot,
-- see CLAUDE.md pgTAP note).
-- =====================================================================

BEGIN;
SELECT plan(39);

-- Seed as the migration superuser: a manager and a front desk in studio
-- A, a studio-A audit row, and a pending invitation for member A.
INSERT INTO users (id, studio_id, email, display_name, role, consents) VALUES
    ('11111111-1111-4111-8111-111111111115', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'manager-a@athlya.test', 'Manager A', 'manager',
     '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb),
    ('11111111-1111-4111-8111-111111111116', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'accueil-a@athlya.test', 'Accueil A', 'accueil',
     '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb);

INSERT INTO audit_log (actor_id, action, studio_id, metadata) VALUES
    ('11111111-1111-4111-8111-111111111113', 'team.seed', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{}'::jsonb);

INSERT INTO studio_invitations (id, studio_id, email, role, token_hash, expires_at) VALUES
    ('a0520000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member-a@athlya.test', 'accueil',
     repeat('a', 64), now() + interval '7 days'),
    ('a0520000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'someone@athlya.test', 'coach',
     repeat('b', 64), now() + interval '7 days');

-- ---------- hardening ----------

SELECT ok(
    (SELECT bool_and(p.prosecdef
        AND pg_get_userbyid(p.proowner) = 'athlya_owner'
        AND 'search_path=public, pg_temp' = ANY (p.proconfig)
        AND has_function_privilege('athlya_app', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('athlya_cron', p.oid, 'EXECUTE'))
       FROM pg_proc p
      WHERE p.oid IN ('team_invite(text, text, text, timestamptz)'::regprocedure,
                      'team_set_member_role(uuid, text)'::regprocedure,
                      'team_revoke_invitation(uuid)'::regprocedure,
                      'team_accept_invitation(text)'::regprocedure,
                      'checkin_mark_reservation(uuid, timestamptz)'::regprocedure)),
    'team functions and checkin_mark_reservation: SECURITY DEFINER, athlya_owner, pinned search_path, athlya_app only'
);

SELECT ok(
    NOT has_column_privilege('athlya_app', 'studio_invitations', 'token_hash', 'SELECT')
    AND has_column_privilege('athlya_app', 'studio_invitations', 'email', 'SELECT')
    AND NOT has_table_privilege('athlya_app', 'studio_invitations', 'INSERT'),
    'studio_invitations: athlya_app reads every column but the token digest and writes nothing'
);

SET LOCAL ROLE athlya_app;

-- ---------- manager A ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111115', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'manager');

SELECT is((SELECT count(*)::int FROM users), 6,
    'users_read_same_studio: a manager reads every user of the studio');
SELECT is((SELECT count(*)::int FROM reservations), 2,
    'reservations_read_admin_same_studio: a manager reads the reservations of the studio');
SELECT is((SELECT count(*)::int FROM audit_log WHERE action = 'team.seed'), 1,
    'audit_admin_only: a manager reads the audit log of the studio');
SELECT is((SELECT count(*)::int FROM studio_invitations), 2,
    'studio_invitations_read_managers: a manager reads the invitations of the studio');

SELECT isnt_empty(
    $$ UPDATE classes SET title = 'Yoga Flow A+' WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccca' RETURNING id $$,
    'classes_update_admin: a manager edits a class of the studio'
);
SELECT is_empty(
    $$ UPDATE classes SET title = 'Hijack' WHERE id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccb' RETURNING id $$,
    'classes_update_admin: a manager cannot edit a class of another studio'
);
SELECT lives_ok(
    $$ INSERT INTO classes (studio_id, title, starts_at, duration_min, capacity, version)
       VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Manager made', '2030-02-01 09:00:00+00', 60, 10, 0) $$,
    'classes_insert_admin: a manager creates a class'
);
SELECT lives_ok(
    $$ INSERT INTO programs (studio_id, title) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Manager plan') $$,
    'programs_admin_insert: a manager creates a program'
);
SELECT isnt_empty(
    $$ UPDATE reservations SET status = 'cancelled', cancelled_at = now()
        WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddd02' RETURNING id $$,
    'reservations_update_admin: a manager updates a reservation of the studio'
);
SELECT is_empty(
    $$ UPDATE users SET display_name = 'Renamed' WHERE id = '11111111-1111-4111-8111-111111111111' RETURNING id $$,
    'users_update_admin: a manager cannot write another user''s row'
);
SELECT throws_ok(
    $$ SELECT * FROM team_set_member_role('11111111-1111-4111-8111-111111111111', 'coach') $$,
    '42501', NULL,
    'team_set_member_role: a manager cannot change a role'
);
SELECT throws_ok(
    $$ SELECT * FROM team_invite('new@athlya.test', 'coach', repeat('c', 64), now() + interval '7 days') $$,
    '42501', NULL,
    'team_invite: a manager cannot invite'
);

-- ---------- accueil A ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111116', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'accueil');

SELECT is((SELECT count(*)::int FROM users), 6,
    'users_read_same_studio: the front desk reads every user of the studio');
SELECT is((SELECT count(*)::int FROM reservations), 2,
    'reservations_read_admin_same_studio: the front desk reads the reservations of the studio');
SELECT is((SELECT count(*)::int FROM audit_log), 0,
    'audit_admin_only: the front desk reads no audit row');
SELECT is((SELECT count(*)::int FROM studio_invitations), 0,
    'studio_invitations_read_managers: the front desk reads no invitation');
SELECT is_empty(
    $$ UPDATE classes SET title = 'Desk edit' WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccca' RETURNING id $$,
    'classes_update_admin: the front desk cannot edit a class'
);
SELECT throws_ok(
    $$ INSERT INTO classes (studio_id, title, starts_at, duration_min, capacity, version)
       VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Desk made', '2030-02-01 09:00:00+00', 60, 10, 0) $$,
    '42501', NULL,
    'classes_insert_admin: the front desk cannot create a class'
);
SELECT is_empty(
    $$ UPDATE reservations SET checked_in_at = now()
        WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddd01' RETURNING id $$,
    'reservations_update_admin: the front desk cannot update a reservation directly'
);
SELECT results_eq(
    $$ SELECT id FROM checkin_mark_reservation('dddddddd-dddd-4ddd-8ddd-dddddddddd01', '2030-01-01 08:50:00+00') $$,
    $$ VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddd01'::uuid) $$,
    'checkin_mark_reservation: the front desk checks a member in'
);
SELECT throws_ok(
    $$ SELECT * FROM team_revoke_invitation('a0520000-0000-4000-8000-000000000002') $$,
    '42501', NULL,
    'team_revoke_invitation: the front desk cannot revoke an invitation'
);

-- ---------- member A ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member');

SELECT throws_ok(
    $$ SELECT * FROM checkin_mark_reservation('dddddddd-dddd-4ddd-8ddd-dddddddddd01', '2030-01-01 08:55:00+00') $$,
    '42501', NULL,
    'checkin_mark_reservation: a member caller is refused'
);
SELECT throws_ok(
    $$ SELECT token_hash FROM studio_invitations $$,
    '42501', NULL,
    'studio_invitations: athlya_app cannot select the token digest'
);
SELECT is_empty(
    $$ SELECT * FROM team_accept_invitation(repeat('b', 64)) $$,
    'team_accept_invitation: an invitation for another email is not accepted'
);
SELECT results_eq(
    $$ SELECT role::text FROM team_accept_invitation(repeat('a', 64)) $$,
    $$ VALUES ('accueil') $$,
    'team_accept_invitation: the invited account takes the invited role'
);
SELECT is_empty(
    $$ SELECT * FROM team_accept_invitation(repeat('a', 64)) $$,
    'team_accept_invitation: an invitation is accepted only once'
);

-- ---------- admin B ----------

SELECT test_set_tenant('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'admin');

SELECT is(
    (SELECT team_revoke_invitation(id) FROM (VALUES ('a0520000-0000-4000-8000-000000000002'::uuid)) AS v(id)),
    false,
    'team_revoke_invitation: an admin of another studio revokes nothing'
);

-- ---------- admin A ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111113', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin');

SELECT results_eq(
    $$ SELECT outcome, user_id FROM team_invite('MEMBER-A2@athlya.test', 'coach', repeat('d', 64), now() + interval '7 days') $$,
    $$ VALUES ('role_updated'::text, '11111111-1111-4111-8111-111111111112'::uuid) $$,
    'team_invite: an account of the studio gets the role at once (email matched case-insensitively)'
);
SELECT results_eq(
    $$ SELECT role::text, credentials_version FROM users WHERE id = '11111111-1111-4111-8111-111111111112' $$,
    $$ VALUES ('coach', 2) $$,
    'team_invite: the role change bumps credentials_version'
);
SELECT results_eq(
    $$ SELECT outcome FROM team_invite('someone@athlya.test', 'manager', repeat('e', 64), now() + interval '7 days') $$,
    $$ VALUES ('invited'::text) $$,
    'team_invite: an unknown email gets a pending invitation'
);
SELECT results_eq(
    $$ SELECT role::text, revoked_at IS NULL FROM studio_invitations
        WHERE email = 'someone@athlya.test' ORDER BY created_at, revoked_at NULLS LAST $$,
    $$ VALUES ('coach', false), ('manager', true) $$,
    'team_invite: a new invitation replaces the pending one for the same email'
);
SELECT throws_ok(
    $$ SELECT * FROM team_invite('admin-a@athlya.test', 'coach', repeat('f', 64), now() + interval '7 days') $$,
    'P0001', 'cannot_change_own_role',
    'team_invite: an admin cannot change their own role'
);
SELECT throws_ok(
    $$ SELECT * FROM team_invite('x@athlya.test', 'member', repeat('f', 64), now() + interval '7 days') $$,
    '22023', 'invalid_team_role',
    'team_invite: member is not an invitable role'
);
SELECT results_eq(
    $$ SELECT id, role::text FROM team_set_member_role('11111111-1111-4111-8111-111111111116', 'member') $$,
    $$ VALUES ('11111111-1111-4111-8111-111111111116'::uuid, 'member') $$,
    'team_set_member_role: an admin takes an account off the team'
);
SELECT is_empty(
    $$ SELECT * FROM team_set_member_role('22222222-2222-4222-8222-222222222221', 'coach') $$,
    'team_set_member_role: an account of another studio is not found'
);
SELECT throws_ok(
    $$ SELECT * FROM team_set_member_role('11111111-1111-4111-8111-111111111113', 'member') $$,
    'P0001', 'cannot_change_own_role',
    'team_set_member_role: an admin cannot change their own role'
);
SELECT is(
    (SELECT team_revoke_invitation(id) FROM studio_invitations
      WHERE email = 'someone@athlya.test' AND revoked_at IS NULL),
    true,
    'team_revoke_invitation: an admin revokes a pending invitation of the studio'
);

SELECT * FROM finish();
ROLLBACK;
