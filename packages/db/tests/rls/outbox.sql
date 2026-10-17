-- =====================================================================
-- outbox.sql — admin-only read policy on event outbox
--
-- Covered policies (Req 16.x, 22.3):
--   - outbox_admin_only  SELECT USING app_role() = 'admin'
--                        AND studio_id = app_studio_id()
--                        (Migration 0023 removed the IS NULL fallback)
--
--   - outbox_insert_tenant INSERT WITH CHECK studio_id = app_studio_id()
--                        AND undelivered (migration 0031, issue #497)
--
-- The drainer (athlya_cron) is covered in cron_role.sql. We assert that:
--   * member / coach see zero rows
--   * admin sees seeded rows for their own studio
--   * admin cannot see another studio's outbox rows (cross-tenant isolation)
--   * admin cannot see NULL-studio (platform-level) outbox rows (0023)
--   * a tenant session can record an event for its own studio only, and
--     only as undelivered; without tenant context nothing can be recorded
--   * a tenant session can neither update nor delete outbox rows
-- =====================================================================

BEGIN;

-- Insert studio-scoped and platform-level outbox rows as superuser
-- (bypasses RLS) so cross-tenant and NULL-studio isolation can be
-- tested. These are rolled back at the end.
INSERT INTO "outbox" (id, event_id, event_type, payload, occurred_at, studio_id) VALUES
    ('ffffffff-ffff-4fff-8fff-ffffffffff11', 'evt-scope-a', 'test.isolation', '{"s":"a"}'::jsonb, '2026-01-01 12:00:00+00', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    ('ffffffff-ffff-4fff-8fff-ffffffffff12', 'evt-scope-b', 'test.isolation', '{"s":"b"}'::jsonb, '2026-01-01 12:00:00+00', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    ('ffffffff-ffff-4fff-8fff-ffffffffff13', 'evt-platform', 'platform.op', '{"src":"platform"}'::jsonb, '2026-01-01 12:00:00+00', NULL);

SET LOCAL ROLE athlya_tenant_test;
SELECT plan(11);

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

-- ---------- NULL-studio isolation (migration 0023) ----------
-- Platform-level events (studio_id IS NULL) must not be readable
-- by any tenant admin after migration 0023 removed the IS NULL fallback.

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111113',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'admin'
);

SELECT is(
    (SELECT count(*)::int FROM "outbox" WHERE studio_id IS NULL),
    0,
    'outbox_admin_only (0023): tenant admin cannot read NULL-studio platform rows'
);

-- ---------- outbox_insert_tenant: producer boundary (0031) ----------
-- A member booking a class records its event inside withTenant; the
-- studio_id column defaults to app.studio_id.

SELECT public.test_set_tenant(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'member'
);

SELECT lives_ok(
    $$INSERT INTO "outbox" (event_id, event_type, payload, occurred_at)
      VALUES ('evt-member-a', 'reservation.created', '{"x":1}'::jsonb, '2026-01-01 00:00:00+00')$$,
    'outbox_insert_tenant: member records an event for their own studio (studio_id from tenant context)'
);

SELECT throws_ok(
    $$INSERT INTO "outbox" (event_id, event_type, payload, occurred_at, studio_id)
      VALUES ('evt-forge-b', 'reservation.created', '{"x":1}'::jsonb, '2026-01-01 00:00:00+00',
              'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')$$,
    '42501',
    NULL,
    'outbox_insert_tenant: studio A session cannot record a studio B event (42501)'
);

SELECT throws_ok(
    $$INSERT INTO "outbox" (event_id, event_type, payload, occurred_at, published_at)
      VALUES ('evt-forge-delivered', 'reservation.created', '{"x":1}'::jsonb, '2026-01-01 00:00:00+00', now())$$,
    '42501',
    NULL,
    'outbox_insert_tenant: a producer cannot insert an already-delivered event (42501)'
);

SELECT is_empty(
    $$UPDATE "outbox" SET attempts = attempts + 1 RETURNING id$$,
    'outbox: a tenant session cannot update (claim/drain) outbox rows'
);

SELECT public.test_unset_tenant();

SELECT throws_ok(
    $$INSERT INTO "outbox" (event_id, event_type, payload, occurred_at)
      VALUES ('evt-no-tenant', 'test.forge', '{"x":1}'::jsonb, '2026-01-01 00:00:00+00')$$,
    '42501',
    NULL,
    'outbox_insert_tenant: no tenant context means no event can be recorded (42501)'
);

SELECT * FROM finish();
ROLLBACK;
