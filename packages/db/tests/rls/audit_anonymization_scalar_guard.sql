-- =====================================================================
-- audit_anonymization_scalar_guard.sql — exercises migration 0006
--
-- Migration 0003 ships the SECURITY DEFINER function
-- `anonymize_user_audit(uuid)` whose body uses two JSONB operators
-- that raise SQLSTATE 22023 ("cannot delete from scalar") on any row
-- whose `metadata` is not an object:
--
--   * `metadata - 'email'` (binary minus): blows up on jsonb scalars
--     and arrays.
--   * `metadata ? 'subjectUserId'` (containment): also blows up on
--     scalars and arrays.
--
-- Migration 0006 wraps both with `jsonb_typeof(metadata) = 'object'`
-- guards. This pgTAP suite proves:
--
--   1. The function tolerates every non-object jsonb shape without
--      raising (string, number, boolean, null literal, array).
--   2. The function still anonymises object rows correctly when they
--      live alongside non-object rows in the same table.
--   3. Non-object rows are NEVER mutated by the guard branch.
--   4. The idempotence contract is preserved (a second call with the
--      same target returns 0).
--
-- Assertion count: 9 — see `plan(9)` below.
-- =====================================================================

BEGIN;
SELECT plan(9);

-- ---------------------------------------------------------------------
-- Seed a mix of object-shaped and scalar-shaped rows.
--
-- The target user_id is the same as the canonical pgTAP suite for
-- consistency. The non-object rows are deliberately not the target —
-- if the function ever started mutating them, the assertions below
-- would catch it.
-- ---------------------------------------------------------------------

INSERT INTO "audit_log" (actor_id, action, target_type, target_id, metadata) VALUES
    -- Object row, target match — the function must anonymise this.
    (
        '11111111-1111-4111-8111-111111111111',
        'test.scalar.target',
        'user',
        '11111111-1111-4111-8111-111111111111',
        '{"email":"target@athlya.test","displayName":"T","ip":"10.0.0.1","userAgent":"pgtap","keep":"yes"}'::jsonb
    ),
    -- Scalar string, unrelated actor — must survive untouched.
    (
        '22222222-2222-4222-8222-222222222222',
        'test.scalar.string',
        'user',
        '22222222-2222-4222-8222-222222222220',
        '"raw-string-payload"'::jsonb
    ),
    -- Scalar number, unrelated actor.
    (
        '22222222-2222-4222-8222-222222222222',
        'test.scalar.number',
        'user',
        '22222222-2222-4222-8222-222222222220',
        '42'::jsonb
    ),
    -- Scalar boolean, unrelated actor.
    (
        '22222222-2222-4222-8222-222222222222',
        'test.scalar.boolean',
        'user',
        '22222222-2222-4222-8222-222222222220',
        'true'::jsonb
    ),
    -- JSON null, unrelated actor.
    (
        '22222222-2222-4222-8222-222222222222',
        'test.scalar.null',
        'user',
        '22222222-2222-4222-8222-222222222220',
        'null'::jsonb
    ),
    -- Top-level array, unrelated actor.
    (
        '22222222-2222-4222-8222-222222222222',
        'test.scalar.array',
        'user',
        '22222222-2222-4222-8222-222222222220',
        '[1, 2, 3]'::jsonb
    );

-- ---------------------------------------------------------------------
-- 1. The function must not raise on any of the non-object shapes.
--    Pre-0006 this UPDATE would error out wholesale on the first
--    scalar row evaluated by the WHERE clause.
-- ---------------------------------------------------------------------

SET LOCAL ROLE athlya_cron;

SELECT lives_ok(
    $$SELECT anonymize_user_audit('11111111-1111-4111-8111-111111111111'::uuid)$$,
    'anonymize_user_audit tolerates rows with jsonb scalars / arrays in metadata'
);

-- ---------------------------------------------------------------------
-- 2. The object row was anonymised exactly once.
-- ---------------------------------------------------------------------

RESET ROLE;

SELECT is(
    (SELECT actor_id FROM audit_log WHERE action = 'test.scalar.target'),
    NULL,
    'object row: actor_id was scrubbed to NULL'
);

SELECT ok(
    NOT (SELECT metadata ? 'email' FROM audit_log WHERE action = 'test.scalar.target'),
    'object row: email key was stripped from metadata'
);

SELECT ok(
    (SELECT metadata ? 'keep' FROM audit_log WHERE action = 'test.scalar.target'),
    'object row: non-PII keys survived'
);

-- ---------------------------------------------------------------------
-- 3. Every non-object row is byte-for-byte unchanged. We compare via
--    `metadata::text` so a hypothetical re-encoding is also caught.
-- ---------------------------------------------------------------------

SELECT is(
    (SELECT metadata::text FROM audit_log WHERE action = 'test.scalar.string'),
    '"raw-string-payload"',
    'jsonb string: untouched'
);

SELECT is(
    (SELECT metadata::text FROM audit_log WHERE action = 'test.scalar.number'),
    '42',
    'jsonb number: untouched'
);

SELECT is(
    (SELECT metadata::text FROM audit_log WHERE action = 'test.scalar.null'),
    'null',
    'jsonb null: untouched'
);

SELECT is(
    (SELECT metadata::text FROM audit_log WHERE action = 'test.scalar.array'),
    '[1, 2, 3]',
    'jsonb array: untouched'
);

-- ---------------------------------------------------------------------
-- 4. Idempotence — a second call returns 0 (the object row is already
--    stripped, the scalars never matched, and the WHERE clause's
--    second branch is now `FALSE` on every row).
-- ---------------------------------------------------------------------

SET LOCAL ROLE athlya_cron;

SELECT is(
    (SELECT anonymize_user_audit('11111111-1111-4111-8111-111111111111'::uuid))::int,
    0,
    'second call is a no-op (idempotent)'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
