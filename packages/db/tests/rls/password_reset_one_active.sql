-- =====================================================================
-- password_reset_one_active.sql — partial unique index on
-- password_reset_tokens (migration 0029, issue #522)
--
-- Verifies the semantics of the partial unique index
-- `password_reset_tokens_user_active_uidx` (WHERE consumed_at IS NULL):
--
--   1. Inserting a second active token for the same user is rejected.
--   2. Inserting an active token after the first is consumed succeeds
--      (consumed rows are outside the partial index).
--   3. Two consumed tokens for the same user can coexist (forensic
--      history must be preserved).
--
-- All changes are rolled back at the end.
-- =====================================================================

BEGIN;

SELECT plan(3);

-- Seed a known user for testing.
DO $$
DECLARE
  v_studio_id UUID := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  v_user_id   UUID := 'f0000001-0000-4000-8000-000000000001';
BEGIN
  INSERT INTO users (id, studio_id, email, display_name, role, consents)
  VALUES (
    v_user_id,
    v_studio_id,
    'reset-test@athlya.test',
    'Reset Test User',
    'member',
    '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb
  )
  ON CONFLICT DO NOTHING;
END;
$$;

-- 1. Two active tokens for the same user → rejected (23505).
DO $$
BEGIN
  INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
  VALUES (
    'f0000001-0000-4000-8000-000000000010',
    'f0000001-0000-4000-8000-000000000001',
    'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
    NOW() + INTERVAL '1 hour'
  );
END;
$$;

SELECT throws_ok(
  $$INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
    VALUES (
      'f0000001-0000-4000-8000-000000000011',
      'f0000001-0000-4000-8000-000000000001',
      'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222',
      NOW() + INTERVAL '1 hour'
    )$$,
  '23505',
  NULL,
  'second active token for same user is rejected (password_reset_tokens_user_active_uidx, 23505)'
);

-- 2. Consumed first token + new active token for same user → succeeds.
UPDATE password_reset_tokens
SET consumed_at = NOW()
WHERE id = 'f0000001-0000-4000-8000-000000000010';

SELECT lives_ok(
  $$INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
    VALUES (
      'f0000001-0000-4000-8000-000000000012',
      'f0000001-0000-4000-8000-000000000001',
      'cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333',
      NOW() + INTERVAL '1 hour'
    )$$,
  'new active token after first was consumed succeeds'
);

-- 3. Two consumed tokens for same user can coexist (forensic history).
UPDATE password_reset_tokens
SET consumed_at = NOW()
WHERE id = 'f0000001-0000-4000-8000-000000000012';

SELECT lives_ok(
  $$INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
    VALUES (
      'f0000001-0000-4000-8000-000000000013',
      'f0000001-0000-4000-8000-000000000001',
      'dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444',
      NOW() + INTERVAL '1 hour'
    )$$,
  'third token after both predecessors consumed is allowed (forensic history preserved)'
);

-- Consume the last token so no active row remains after rollback.
UPDATE password_reset_tokens SET consumed_at = NOW()
WHERE id = 'f0000001-0000-4000-8000-000000000013';

ROLLBACK;
