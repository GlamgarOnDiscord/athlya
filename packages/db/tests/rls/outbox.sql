-- =====================================================================
-- outbox.sql — admin-only read policy on event outbox
--
-- Covered policies (Req 16.x, 22.3):
--   - outbox_admin_only  SELECT USING app_role() = 'admin'
--                        AND (studio_id IS NULL OR studio_id = app_studio_id())
--
-- The drain worker runs under a BYPASSRLS service role; no application
-- role has INSERT / UPDATE / DELETE. We assert that:
--   * member / coach see zero rows
--   * admin sees seeded rows for their own studio
--   * admin cannot see another studio's outbox rows (cross-tenant isolation)
--   * no INSERT policy exists for a member (INSERT from tenant context
--     must fail regardless of user_id because there is no matching
--     WITH CHECK).
-- =====================================================================

BEGIN;

-- Insert studio-scoped outbox rows as superuser (bypasses RLS) so
-- cross-tenant isolation can be tested. These are rolled back at the end.
INSERT INTO "outbox" (id, event_id, event_type, payload, occurred_at, studio_id) VALUES
    ('ffffffff-ffff-4fff-8fff-ffffffffff11', 'evt-scope-a', 'test.isolation', '{"s":"a"}'::jsonb, '2026-01-01 12:00:00+00', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    ('ffffffff-ffff-4fff-8fff-ffffffffff12', 'evt-scope-b', 'test.isolation', '{"s":"b"}'::jsonb, '2026-01-01 12:00:00+00', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

SET LOCAL ROLE athlya_tenant_test;
SELECT plan(6);

-- ---------- outbox_admin_only: member ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

SELECT is(
    (SELECT count(*)::int FROM "outbox"),
    0,
    'outbox_admin_only: member sees zero outbox rows'
);

-- ---------- outbox_admin_only: coach ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111114',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'coach'
);

SELECT is(
    (SELECT count(*)::int FROM "outbox"),
    0,
    'outbox_admin_only: coach sees zero outbox rows (admin-only policy)'
);

-- ---------- outbox_admin_only: admin ----------

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111113',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'admin'
);

SELECT cmp_ok(
    (SELECT count(*)::int FROM "outbox"),
    '>',
    0,
    'outbox_admin_only: admin can read outbox rows for their studio'
);

-- ---------- cross-tenant isolation: admin_A cannot see studio_B rows ----------

SELECT is(
    (SELECT count(*)::int FROM "outbox"
     WHERE studio_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    0,
    'outbox_admin_only: admin_A cannot read studio_B outbox rows (cross-tenant isolation)'
);

-- ---------- cross-tenant isolation: admin_B cannot see studio_A rows ----------

SELECT public.test_set_tenant(
    '22222222-2222-4222-8222-222222222222',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'admin'
);

SELECT is(
    (SELECT count(*)::int FROM "outbox"
     WHERE studio_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    0,
    'outbox_admin_only: admin_B cannot read studio_A outbox rows (cross-tenant isolation)'
);

-- ---------- no INSERT policy: tenant role is blocked ----------
-- Because `0001_rls.sql` never declares a FOR INSERT policy on outbox,
-- an INSERT from any non-BYPASSRLS session fails with 42501. We run
-- this with role = admin to prove that not even the most privileged
-- tenant context can forge events.

SELECT throws_ok(
    $$INSERT INTO "outbox" (event_id, event_type, payload, occurred_at)
      VALUES ('evt-forge', 'test.forge', '{"x":1}'::jsonb, '2026-01-01 00:00:00+00')$$,
    '42501',
    NULL,
    'outbox has no INSERT policy: admin tenant INSERT raises SQLSTATE 42501'
);

SELECT * FROM finish();
ROLLBACK;
