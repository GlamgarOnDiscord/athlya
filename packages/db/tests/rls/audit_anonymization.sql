-- =====================================================================
-- audit_anonymization.sql — exercises migration 0003_audit_anonymization
--
-- Covers Requirements 5.3, 22.2 and 22.3 (hardening task H1).
--
-- Threat model under test:
--   * `athlya_app` is the production-intended application role. It
--     holds SELECT + INSERT on audit_log, nothing else. Any attempt to
--     UPDATE or DELETE must be rejected at the privilege layer
--     (SQLSTATE 42501) before the RLS filter or the trigger even get
--     a chance to run.
--   * `athlya_cron` is the J+30 RGPD worker's identity. It holds *no*
--     direct grants on audit_log — it cannot even SELECT it. Its only
--     capability is EXECUTE on the `anonymize_user_audit(uuid)`
--     SECURITY DEFINER function.
--   * `athlya_owner` is the privileged role that owns both the
--     function and the audit_log table. Nothing outside the function
--     body should ever reach this role's identity.
--
-- Verification strategy:
--   1. Seed three well-known rows inside the test transaction so the
--      assertions do not depend on the shared bootstrap data.
--   2. Switch into each role in turn via `SET LOCAL ROLE` (the outer
--      psql session is superuser, which can SET ROLE to anything).
--   3. Assert the expected failure mode for direct DML, then the
--      expected success for the sanctioned path.
--   4. RESET ROLE before post-conditions so the superuser session can
--      SELECT the modified rows without running into the cron role's
--      lack of SELECT grant.
--
-- Assertion count: 13 — see `plan(13)` below.
-- =====================================================================

BEGIN;
SELECT plan(13);

-- ---------------------------------------------------------------------
-- 1. Seed three audit_log rows with deterministic metadata
--
-- We deliberately do the INSERT as the outer superuser, before any
-- SET ROLE. Two reasons:
--   * Superuser bypasses RLS and `audit_no_insert`, so the INSERT
--     lands.
--   * The `audit_log_immutable()` trigger only fires on UPDATE /
--     DELETE, so INSERTs pass regardless of role.
--
-- Row layout:
--   target     — actor_id matches the target uuid directly. Carries
--                every PII key we expect the function to strip
--                (email, displayName, ip, userAgent) plus one
--                non-PII key ("other") that must be preserved.
--   subject    — actor_id is a DIFFERENT admin; metadata carries
--                `subjectUserId = target::text`, which the function
--                must also anonymize via the OR-branch of its WHERE
--                clause.
--   unrelated  — actor_id is unrelated; metadata carries no
--                subjectUserId. The function must NOT touch this row.
-- ---------------------------------------------------------------------

INSERT INTO "audit_log" (actor_id, action, target_type, target_id, metadata) VALUES
    -- target: direct actor match
    ('11111111-1111-4111-8111-111111111111',
     'test.target',
     'user',
     '11111111-1111-4111-8111-111111111111',
     '{"email":"target@athlya.test","displayName":"Target User","ip":"10.0.0.1","userAgent":"pgtap","other":"keep"}'::jsonb),
    -- subject: admin acting ON the target, referenced via metadata
    ('11111111-1111-4111-8111-111111111113',
     'test.subject',
     'user',
     '11111111-1111-4111-8111-111111111111',
     '{"subjectUserId":"11111111-1111-4111-8111-111111111111","email":"admin@athlya.test","ip":"10.0.0.2","other":"keep"}'::jsonb),
    -- unrelated: no link to the target, must survive untouched
    ('22222222-2222-4222-8222-222222222222',
     'test.unrelated',
     'user',
     '22222222-2222-4222-8222-222222222221',
     '{"email":"unrelated@athlya.test","other":"keep"}'::jsonb);

-- ---------------------------------------------------------------------
-- 2. athlya_app cannot UPDATE or DELETE audit_log
--    (privilege layer — before RLS, before trigger)
-- ---------------------------------------------------------------------

SET LOCAL ROLE athlya_app;

SELECT throws_ok(
    $$UPDATE "audit_log" SET actor_id = NULL WHERE action = 'test.target'$$,
    '42501',
    NULL,
    'athlya_app UPDATE audit_log fails with SQLSTATE 42501 (no UPDATE grant)'
);

SELECT throws_ok(
    $$DELETE FROM "audit_log" WHERE action = 'test.target'$$,
    '42501',
    NULL,
    'athlya_app DELETE FROM audit_log fails with SQLSTATE 42501 (no DELETE grant)'
);

-- ---------------------------------------------------------------------
-- 3. athlya_cron cannot UPDATE or DELETE audit_log directly either.
--    It holds no table grants at all; only the function EXECUTE.
-- ---------------------------------------------------------------------

RESET ROLE;
SET LOCAL ROLE athlya_cron;

SELECT throws_ok(
    $$UPDATE "audit_log" SET actor_id = NULL WHERE action = 'test.target'$$,
    '42501',
    NULL,
    'athlya_cron UPDATE audit_log fails with SQLSTATE 42501 (no direct grant)'
);

SELECT throws_ok(
    $$DELETE FROM "audit_log" WHERE action = 'test.target'$$,
    '42501',
    NULL,
    'athlya_cron DELETE FROM audit_log fails with SQLSTATE 42501 (no direct grant)'
);

-- ---------------------------------------------------------------------
-- 4. athlya_app cannot call anonymize_user_audit either —
--    the EXECUTE grant is scoped to athlya_cron only.
-- ---------------------------------------------------------------------

RESET ROLE;
SET LOCAL ROLE athlya_app;

SELECT throws_ok(
    $$SELECT anonymize_user_audit('11111111-1111-4111-8111-111111111111'::uuid)$$,
    '42501',
    NULL,
    'athlya_app cannot EXECUTE anonymize_user_audit (SQLSTATE 42501)'
);

-- ---------------------------------------------------------------------
-- 5. athlya_cron CAN call anonymize_user_audit — the sanctioned path.
--
-- The function touches the `target` and `subject` rows (2 rows)
-- because both match the OR-predicate (actor_id OR subjectUserId).
-- The `unrelated` row must stay put.
-- ---------------------------------------------------------------------

RESET ROLE;
SET LOCAL ROLE athlya_cron;

SELECT is(
    (SELECT anonymize_user_audit('11111111-1111-4111-8111-111111111111'::uuid))::int,
    2,
    'anonymize_user_audit returns 2 touched rows (actor_id match + subjectUserId match)'
);

-- ---------------------------------------------------------------------
-- 6. Post-conditions: verify the function did what we expect.
--
-- athlya_cron has no SELECT grant on audit_log, so we drop the role
-- back to the superuser session here to inspect the rows directly.
-- Superuser bypasses RLS, so the policies do not hide anything.
-- ---------------------------------------------------------------------

RESET ROLE;

-- actor_id on the direct-match row is now NULL
SELECT is(
    (SELECT actor_id FROM "audit_log" WHERE action = 'test.target'),
    NULL::uuid,
    'target row: actor_id set to NULL after anonymization'
);

-- actor_id on the subjectUserId-match row is now NULL too
SELECT is(
    (SELECT actor_id FROM "audit_log" WHERE action = 'test.subject'),
    NULL::uuid,
    'subject row: actor_id set to NULL (matched via metadata.subjectUserId)'
);

-- PII keys stripped from the direct-match row
SELECT is(
    (SELECT metadata FROM "audit_log" WHERE action = 'test.target'),
    '{"other":"keep"}'::jsonb,
    'target row: metadata has all four PII keys stripped, non-PII "other" preserved'
);

-- PII keys stripped from the subject row but subjectUserId kept
-- (by design — subjectUserId is a reference, not PII per se, and is
-- useful for forensic traceability).
SELECT is(
    (SELECT metadata FROM "audit_log" WHERE action = 'test.subject'),
    '{"other":"keep","subjectUserId":"11111111-1111-4111-8111-111111111111"}'::jsonb,
    'subject row: email/ip stripped; subjectUserId + non-PII keys preserved'
);

-- The unrelated row must remain exactly as inserted.
SELECT is(
    (SELECT actor_id FROM "audit_log" WHERE action = 'test.unrelated'),
    '22222222-2222-4222-8222-222222222222'::uuid,
    'unrelated row: actor_id untouched (not in anonymization scope)'
);

SELECT is(
    (SELECT metadata FROM "audit_log" WHERE action = 'test.unrelated'),
    '{"email":"unrelated@athlya.test","other":"keep"}'::jsonb,
    'unrelated row: metadata untouched (email kept — not the target user)'
);

-- ---------------------------------------------------------------------
-- 7. Calling the function with a UUID that matches nothing returns 0.
--
-- This exercises the empty-scope branch and confirms the function is
-- safe to call repeatedly: running it against a user whose rows were
-- never audited (or already anonymized, on the actor_id side) is a
-- no-op rather than an error. The `unrelated` row survives this call
-- because its actor_id differs from the probe UUID.
-- ---------------------------------------------------------------------

SET LOCAL ROLE athlya_cron;

SELECT is(
    (SELECT anonymize_user_audit('00000000-0000-4000-8000-000000000000'::uuid))::int,
    0,
    'anonymize_user_audit with an unknown UUID returns 0 (no rows touched)'
);

ROLLBACK;
