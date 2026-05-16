-- =====================================================================
-- outbox.sql — admin-only read policy on event outbox
--
-- Covered policies (Req 16.x, 22.3):
--   - outbox_admin_only  SELECT USING app_role() = 'admin'
--
-- The drain worker runs under a BYPASSRLS service role; no application
-- role has INSERT / UPDATE / DELETE. We assert that:
--   * member / coach see zero rows
--   * admin sees all seeded rows
--   * no INSERT policy exists for a member (INSERT from tenant context
--     must fail regardless of user_id because there is no matching
--     WITH CHECK).
-- =====================================================================

BEGIN;
-- Switch to the non-superuser test role so RLS policies actually
-- apply. The session role (postgres) is a superuser and therefore
-- bypasses RLS; the enclosing ROLLBACK restores it at file end.
SET LOCAL ROLE athlya_tenant_test;
SELECT plan(4);

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
    'outbox_admin_only: admin can read outbox rows'
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
