-- =====================================================================
-- training_programs.sql — migration 0042 under the real athlya_app /
-- athlya_cron roles (Epic 24, issue #640)
--
-- Asserts that:
--   - the four program tables are ENABLE + FORCE RLS and invisible to
--     athlya_app without tenant claims and to athlya_cron;
--   - members read published programs and the ones they follow
--     (`programs_read_member`), staff read every program of their
--     studio (`programs_read_staff`), nobody reads another studio's;
--   - weeks and workouts follow their program's visibility
--     (`program_weeks_read_visible`, `program_workouts_read_visible`);
--   - only an admin of the studio writes programs, weeks and workouts
--     (`programs_admin_insert`, `programs_admin_update`,
--     `program_weeks_admin_insert`, `program_weeks_admin_delete`,
--     `program_workouts_admin_insert`, `program_workouts_admin_delete`),
--     and the composite keys stop a cross-studio parent reference;
--   - a user subscribes and unsubscribes only themselves
--     (`program_subscriptions_read_own`, `program_subscriptions_insert_own`,
--     `program_subscriptions_cancel_own`), only to a published program
--     of their studio (trigger), at most once at a time;
--   - `rgpd_delete_program_subscriptions` is locked down and only purges
--     a soft-deleted user's rows.
--
-- Writes and their read-backs are separate statements: `app_studio_id()`
-- and friends are STABLE (see CLAUDE.md, pgTAP note).
-- =====================================================================

BEGIN;
SELECT plan(50);

-- ---------- seed (migration superuser) ----------
--
-- Studio A: published P1, draft P2, P3 (published while member A
-- subscribes, then archived). Studio B: published P4 followed by
-- member B. One week with one day-1 workout per program.

INSERT INTO programs (id, studio_id, title, status) VALUES
    ('a0420000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Strength A',  'published'),
    ('a0420000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Draft A',     'draft'),
    ('a0420000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Archived A',  'published'),
    ('a0420000-0000-4000-8000-000000000004', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Strength B',  'published');

INSERT INTO program_weeks (id, program_id, studio_id, week_number) VALUES
    ('b0420000-0000-4000-8000-000000000001', 'a0420000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1),
    ('b0420000-0000-4000-8000-000000000002', 'a0420000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1),
    ('b0420000-0000-4000-8000-000000000003', 'a0420000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1),
    ('b0420000-0000-4000-8000-000000000004', 'a0420000-0000-4000-8000-000000000004', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1);

INSERT INTO program_workouts (id, week_id, studio_id, day_number, title, exercises) VALUES
    ('c0420000-0000-4000-8000-000000000001', 'b0420000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 'Squat day', '[{"name":"Back squat","sets":5,"reps":5}]'::jsonb),
    ('c0420000-0000-4000-8000-000000000002', 'b0420000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 'Draft day', '[]'::jsonb),
    ('c0420000-0000-4000-8000-000000000003', 'b0420000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 'Old day',   '[]'::jsonb),
    ('c0420000-0000-4000-8000-000000000004', 'b0420000-0000-4000-8000-000000000004', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1, 'B day',     '[]'::jsonb);

INSERT INTO program_subscriptions (id, program_id, studio_id, user_id, starts_on) VALUES
    ('d0420000-0000-4000-8000-000000000001', 'a0420000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', '2026-01-05'),
    ('d0420000-0000-4000-8000-000000000002', 'a0420000-0000-4000-8000-000000000004', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222221', '2026-01-05');

UPDATE programs SET status = 'archived', archived_at = now()
 WHERE id = 'a0420000-0000-4000-8000-000000000003';

-- ---------- hardening ----------

SELECT ok(
    (SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity)
       FROM pg_class c
      WHERE c.oid IN ('programs'::regclass, 'program_weeks'::regclass,
                      'program_workouts'::regclass, 'program_subscriptions'::regclass)),
    'program tables: ENABLE + FORCE ROW LEVEL SECURITY'
);

SELECT ok(
    (SELECT p.prosecdef
        AND pg_get_userbyid(p.proowner) = 'athlya_owner'
        AND 'search_path=public, pg_temp' = ANY (p.proconfig)
        AND has_function_privilege('athlya_app', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('athlya_cron', p.oid, 'EXECUTE')
       FROM pg_proc p
      WHERE p.oid = 'rgpd_delete_program_subscriptions(uuid)'::regprocedure),
    'rgpd_delete_program_subscriptions: SECURITY DEFINER, athlya_owner, pinned search_path, athlya_app only'
);

SELECT ok(
    (SELECT NOT p.prosecdef AND 'search_path=public, pg_temp' = ANY (p.proconfig)
       FROM pg_proc p
      WHERE p.oid = 'enforce_program_subscribable()'::regprocedure),
    'enforce_program_subscribable: SECURITY INVOKER with a pinned search_path'
);

-- ---------- athlya_app without claims ----------

SET LOCAL ROLE athlya_app;
SELECT test_unset_tenant();

SELECT is((SELECT count(*)::int FROM programs), 0,
    'athlya_app without tenant GUCs reads zero programs');
SELECT is((SELECT count(*)::int FROM program_subscriptions), 0,
    'athlya_app without tenant GUCs reads zero subscriptions');

-- ---------- member A ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member');

SELECT results_eq(
    $$ SELECT id FROM programs ORDER BY id $$,
    $$ VALUES ('a0420000-0000-4000-8000-000000000001'::uuid), ('a0420000-0000-4000-8000-000000000003'::uuid) $$,
    'programs_read_member: a member reads published programs and the archived one they follow, no draft, no other studio'
);

SELECT results_eq(
    $$ SELECT id FROM program_weeks ORDER BY id $$,
    $$ VALUES ('b0420000-0000-4000-8000-000000000001'::uuid), ('b0420000-0000-4000-8000-000000000003'::uuid) $$,
    'program_weeks_read_visible: a member reads the weeks of the programs they can see'
);

SELECT results_eq(
    $$ SELECT id FROM program_workouts ORDER BY id $$,
    $$ VALUES ('c0420000-0000-4000-8000-000000000001'::uuid), ('c0420000-0000-4000-8000-000000000003'::uuid) $$,
    'program_workouts_read_visible: a member reads the workouts of the programs they can see'
);

SELECT throws_ok(
    $$ INSERT INTO programs (studio_id, title) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Member made') $$,
    '42501', NULL,
    'programs_admin_insert: a member cannot create a program'
);

UPDATE programs SET title = 'Member edit' WHERE id = 'a0420000-0000-4000-8000-000000000001';

SELECT is(
    (SELECT title FROM programs WHERE id = 'a0420000-0000-4000-8000-000000000001'),
    'Strength A',
    'programs_admin_update: a member update matches no row'
);

SELECT throws_ok(
    $$ INSERT INTO program_weeks (program_id, studio_id, week_number)
       VALUES ('a0420000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2) $$,
    '42501', NULL,
    'program_weeks_admin_insert: a member cannot add a week'
);

SELECT throws_ok(
    $$ INSERT INTO program_workouts (week_id, studio_id, day_number, title)
       VALUES ('b0420000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2, 'Sneaky') $$,
    '42501', NULL,
    'program_workouts_admin_insert: a member cannot add a workout'
);

DELETE FROM program_workouts WHERE id = 'c0420000-0000-4000-8000-000000000001';
DELETE FROM program_weeks WHERE id = 'b0420000-0000-4000-8000-000000000001';

SELECT is(
    (SELECT count(*)::int FROM program_workouts WHERE id = 'c0420000-0000-4000-8000-000000000001'),
    1,
    'program_workouts_admin_delete: a member delete matches no workout'
);

SELECT is(
    (SELECT count(*)::int FROM program_weeks WHERE id = 'b0420000-0000-4000-8000-000000000001'),
    1,
    'program_weeks_admin_delete: a member delete matches no week'
);

SELECT lives_ok(
    $$ INSERT INTO program_subscriptions (id, program_id, studio_id, user_id, starts_on)
       VALUES ('d0420000-0000-4000-8000-000000000003', 'a0420000-0000-4000-8000-000000000001',
               'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', '2026-02-02') $$,
    'program_subscriptions_insert_own: a member subscribes to a published program'
);

SELECT results_eq(
    $$ SELECT id FROM program_subscriptions ORDER BY id $$,
    $$ VALUES ('d0420000-0000-4000-8000-000000000001'::uuid), ('d0420000-0000-4000-8000-000000000003'::uuid) $$,
    'program_subscriptions_read_own: a member reads only their own subscriptions'
);

SELECT throws_ok(
    $$ INSERT INTO program_subscriptions (program_id, studio_id, user_id, starts_on)
       VALUES ('a0420000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
               '11111111-1111-4111-8111-111111111111', '2026-02-03') $$,
    '23505', NULL,
    'a member cannot hold two active subscriptions to the same program'
);

SELECT throws_ok(
    $$ INSERT INTO program_subscriptions (program_id, studio_id, user_id, starts_on)
       VALUES ('a0420000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
               '11111111-1111-4111-8111-111111111111', '2026-02-02') $$,
    'P0001', 'program_not_subscribable',
    'a member cannot subscribe to a draft program'
);

SELECT throws_ok(
    $$ INSERT INTO program_subscriptions (program_id, studio_id, user_id, starts_on)
       VALUES ('a0420000-0000-4000-8000-000000000004', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
               '11111111-1111-4111-8111-111111111111', '2026-02-02') $$,
    'P0001', 'program_not_subscribable',
    'a member cannot subscribe to another studio''s program under their own studio'
);

SELECT throws_ok(
    $$ INSERT INTO program_subscriptions (program_id, studio_id, user_id, starts_on)
       VALUES ('a0420000-0000-4000-8000-000000000004', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
               '11111111-1111-4111-8111-111111111111', '2026-02-02') $$,
    'P0001', 'program_not_subscribable',
    'a member cannot write a subscription row for another studio (the program is invisible to them)'
);

SELECT throws_ok(
    $$ INSERT INTO program_subscriptions (program_id, studio_id, user_id, starts_on)
       VALUES ('a0420000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
               '11111111-1111-4111-8111-111111111112', '2026-02-02') $$,
    '42501', NULL,
    'program_subscriptions_insert_own: a member cannot subscribe someone else'
);

UPDATE program_subscriptions SET cancelled_at = now()
 WHERE id = 'd0420000-0000-4000-8000-000000000003';

SELECT isnt(
    (SELECT cancelled_at FROM program_subscriptions WHERE id = 'd0420000-0000-4000-8000-000000000003'),
    NULL,
    'program_subscriptions_cancel_own: a member unsubscribes'
);

SELECT lives_ok(
    $$ INSERT INTO program_subscriptions (program_id, studio_id, user_id, starts_on)
       VALUES ('a0420000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
               '11111111-1111-4111-8111-111111111111', '2026-03-02') $$,
    'a member re-subscribes after unsubscribing'
);

SELECT throws_ok(
    $$ UPDATE program_subscriptions SET cancelled_at = NULL
        WHERE id = 'd0420000-0000-4000-8000-000000000003' $$,
    '42501', NULL,
    'program_subscriptions_cancel_own: a cancelled subscription cannot be reactivated'
);

SELECT throws_ok(
    $$ UPDATE program_subscriptions SET user_id = '11111111-1111-4111-8111-111111111112'
        WHERE id = 'd0420000-0000-4000-8000-000000000001' $$,
    '42501', NULL,
    'column grant: a subscription cannot be moved to another user'
);

SELECT throws_ok(
    $$ DELETE FROM program_subscriptions WHERE id = 'd0420000-0000-4000-8000-000000000001' $$,
    '42501', NULL,
    'athlya_app cannot hard-delete a subscription (unsubscribe stamps cancelled_at)'
);

-- ---------- member A2: an archived program is closed ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111112', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member');

SELECT is(
    (SELECT count(*)::int FROM programs WHERE id = 'a0420000-0000-4000-8000-000000000003'),
    0,
    'programs_read_member: an archived program is hidden from non-subscribers'
);

SELECT throws_ok(
    $$ INSERT INTO program_subscriptions (program_id, studio_id, user_id, starts_on)
       VALUES ('a0420000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
               '11111111-1111-4111-8111-111111111112', '2026-02-02') $$,
    'P0001', 'program_not_subscribable',
    'nobody can subscribe to an archived program'
);

SELECT is(
    (SELECT count(*)::int FROM program_subscriptions),
    0,
    'program_subscriptions_read_own: member A2 does not see member A''s subscriptions'
);

UPDATE program_subscriptions SET cancelled_at = now()
 WHERE id = 'd0420000-0000-4000-8000-000000000001';

RESET ROLE;
SELECT is(
    (SELECT cancelled_at FROM program_subscriptions WHERE id = 'd0420000-0000-4000-8000-000000000001'),
    NULL,
    'program_subscriptions_cancel_own: member A2 cannot cancel member A''s subscription'
);
SET LOCAL ROLE athlya_app;
SELECT test_set_tenant('11111111-1111-4111-8111-111111111112', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member');

-- ---------- coach A ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111114', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'coach');

SELECT results_eq(
    $$ SELECT id FROM programs ORDER BY id $$,
    $$ VALUES ('a0420000-0000-4000-8000-000000000001'::uuid), ('a0420000-0000-4000-8000-000000000002'::uuid),
              ('a0420000-0000-4000-8000-000000000003'::uuid) $$,
    'programs_read_staff: a coach reads every program of their studio, drafts and archived included'
);

SELECT throws_ok(
    $$ INSERT INTO programs (studio_id, title) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Coach made') $$,
    '42501', NULL,
    'programs_admin_insert: a coach cannot create a program'
);

-- ---------- admin A ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111113', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin');

SELECT lives_ok(
    $$ INSERT INTO programs (id, studio_id, title, created_by)
       VALUES ('a0420000-0000-4000-8000-000000000005', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'New A',
               '11111111-1111-4111-8111-111111111113') $$,
    'programs_admin_insert: an admin creates a program in their studio'
);

SELECT throws_ok(
    $$ INSERT INTO programs (studio_id, title) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Planted') $$,
    '42501', NULL,
    'programs_admin_insert: an admin cannot create a program in another studio'
);

UPDATE programs SET title = 'Draft A v2', version = version + 1
 WHERE id = 'a0420000-0000-4000-8000-000000000002';
UPDATE programs SET title = 'Hijacked' WHERE id = 'a0420000-0000-4000-8000-000000000004';

SELECT results_eq(
    $$ SELECT title, version FROM programs WHERE id = 'a0420000-0000-4000-8000-000000000002' $$,
    $$ VALUES ('Draft A v2'::text, 1) $$,
    'programs_admin_update: an admin edits a program of their studio'
);

SELECT throws_ok(
    $$ UPDATE programs SET studio_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        WHERE id = 'a0420000-0000-4000-8000-000000000002' $$,
    '42501', NULL,
    'column grant: an admin cannot move a program to another studio'
);

UPDATE programs SET status = 'published', archived_at = NULL
 WHERE id = 'a0420000-0000-4000-8000-000000000003';

SELECT results_eq(
    $$ SELECT status::text, archived_at IS NOT NULL FROM programs
        WHERE id = 'a0420000-0000-4000-8000-000000000003' $$,
    $$ VALUES ('archived'::text, true) $$,
    'programs_admin_update: an archived program cannot be revived'
);

UPDATE programs SET status = 'archived', archived_at = now(), version = version + 1
 WHERE id = 'a0420000-0000-4000-8000-000000000005';

SELECT is(
    (SELECT status::text FROM programs WHERE id = 'a0420000-0000-4000-8000-000000000005'),
    'archived',
    'programs_admin_update: an admin archives a live program'
);

SELECT throws_ok(
    $$ DELETE FROM programs WHERE id = 'a0420000-0000-4000-8000-000000000002' $$,
    '42501', NULL,
    'athlya_app cannot hard-delete a program (archive is an update)'
);

DELETE FROM program_weeks WHERE program_id = 'a0420000-0000-4000-8000-000000000002';

SELECT is(
    (SELECT count(*)::int FROM program_workouts WHERE id = 'c0420000-0000-4000-8000-000000000002'),
    0,
    'program_weeks_admin_delete: an admin replaces a week, its workouts cascade'
);

SELECT lives_ok(
    $$ INSERT INTO program_weeks (id, program_id, studio_id, week_number)
       VALUES ('b0420000-0000-4000-8000-000000000005', 'a0420000-0000-4000-8000-000000000002',
               'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1) $$,
    'program_weeks_admin_insert: an admin adds a week'
);

SELECT lives_ok(
    $$ INSERT INTO program_workouts (week_id, studio_id, day_number, title, exercises)
       VALUES ('b0420000-0000-4000-8000-000000000005', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 3, 'Pull day',
               '[{"name":"Row","sets":4,"reps":8}]'::jsonb) $$,
    'program_workouts_admin_insert: an admin adds a workout'
);

DELETE FROM program_workouts WHERE week_id = 'b0420000-0000-4000-8000-000000000005';

SELECT is(
    (SELECT count(*)::int FROM program_workouts WHERE week_id = 'b0420000-0000-4000-8000-000000000005'),
    0,
    'program_workouts_admin_delete: an admin deletes a workout'
);

SELECT throws_ok(
    $$ INSERT INTO program_weeks (program_id, studio_id, week_number)
       VALUES ('a0420000-0000-4000-8000-000000000004', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2) $$,
    '23503', NULL,
    'composite key: an admin cannot attach a week to another studio''s program'
);

SELECT is(
    (SELECT count(*)::int FROM program_subscriptions),
    0,
    'program_subscriptions_read_own: an admin does not read members'' subscriptions'
);

-- ---------- admin B ----------

SELECT test_set_tenant('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'admin');

SELECT results_eq(
    $$ SELECT id, title FROM programs ORDER BY id $$,
    $$ VALUES ('a0420000-0000-4000-8000-000000000004'::uuid, 'Strength B'::text) $$,
    'programs_read_staff: admin B reads only studio B, untouched by admin A'
);

-- ---------- RGPD purge ----------

SELECT test_unset_tenant();

SELECT is(
    rgpd_delete_program_subscriptions('22222222-2222-4222-8222-222222222221'),
    0,
    'rgpd_delete_program_subscriptions: no-op for a live account'
);

RESET ROLE;
UPDATE users SET deleted_at = now() WHERE id = '22222222-2222-4222-8222-222222222221';
SET LOCAL ROLE athlya_app;

SELECT is(
    rgpd_delete_program_subscriptions('22222222-2222-4222-8222-222222222221'),
    1,
    'rgpd_delete_program_subscriptions: purges a soft-deleted user''s subscriptions'
);

-- ---------- athlya_cron ----------

RESET ROLE;
SET LOCAL ROLE athlya_cron;

SELECT throws_ok(
    $$ SELECT count(*) FROM programs $$,
    '42501', NULL,
    'athlya_cron holds no privilege on programs'
);

SELECT throws_ok(
    $$ SELECT count(*) FROM program_subscriptions $$,
    '42501', NULL,
    'athlya_cron holds no privilege on program_subscriptions'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
