-- =====================================================================
-- email_partial_unique.sql — partial unique index on users.email (0026)
--
-- Issue #467. Verifies the semantics of the partial unique index
-- `users_email_active_unique` (WHERE deleted_at IS NULL):
--
--   1. Two active users with the same email must be rejected.
--   2. One active + one soft-deleted user with the same email must succeed.
--   3. Two soft-deleted users with the same email must succeed.
--
-- All inserts are rolled back at the end.
-- =====================================================================

BEGIN;

SELECT plan(3);

-- 1. active + active with same email → unique violation (23505).
SELECT throws_ok(
    $$INSERT INTO "users" (id, studio_id, email, display_name, role, consents)
      VALUES (
        'eeeeeee1-eeee-4eee-8eee-eeeeeeeeeeee',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'member-a@athlya.test',
        'Duplicate Active',
        'member',
        '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb
      )$$,
    '23505',
    NULL,
    'active + active same email is rejected (users_email_active_unique, 23505)'
);

-- ---- helpers ---------------------------------------------------------
-- Only now soft-delete the seeded member-a@athlya.test user, so test 1
-- above collides with an ACTIVE row and tests 2–3 reuse the email as the
-- "deleted" side.

DO $$
BEGIN
  UPDATE "users"
     SET "deleted_at" = NOW() - INTERVAL '1 day'
   WHERE "email" = 'member-a@athlya.test';
END;
$$;

-- 2. active + soft-deleted with same email → must succeed.
SELECT lives_ok(
    $$INSERT INTO "users" (id, studio_id, email, display_name, role, consents)
      VALUES (
        'eeeeeee2-eeee-4eee-8eee-eeeeeeeeeeee',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'member-a@athlya.test',
        'Re-registered Active',
        'member',
        '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb
      )$$,
    'active user re-registering with a soft-deleted email is allowed'
);

-- 3. soft-deleted + soft-deleted same email → must succeed.
SELECT lives_ok(
    $$INSERT INTO "users" (id, studio_id, email, display_name, role, consents, deleted_at)
      VALUES (
        'eeeeeee3-eeee-4eee-8eee-eeeeeeeeeeee',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'member-a@athlya.test',
        'Second Deleted',
        'member',
        '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb,
        NOW() - INTERVAL '2 days'
      )$$,
    'two soft-deleted rows with same email are allowed'
);

SELECT * FROM finish();

ROLLBACK;
