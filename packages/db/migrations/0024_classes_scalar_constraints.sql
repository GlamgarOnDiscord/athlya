-- Migration 0024 — Database CHECK constraints for classes scalar invariants
--
-- Issue #421. Application-layer validation (Zod, service guards) can be
-- bypassed by migrations, direct SQL, scripts, or compromised credentials.
-- Adding CHECK constraints at the persistence boundary ensures invariants
-- hold regardless of how data enters the database.
--
-- Constraints added:
--   classes.capacity:     1 ≤ capacity ≤ 10000
--     Lower bound: a class with 0 or negative capacity is logically invalid.
--     Upper bound 10000: defence-in-depth against accidental large values
--     (no physical venue seats 10000 simultaneously).
--
--   classes.duration_min: 1 ≤ duration_min ≤ 1440
--     Lower bound: a zero or negative duration is logically invalid.
--     Upper bound 1440 (24 h): a class lasting longer than one day is
--     almost certainly a data error.
--
--   workout_sessions.duration_min: duration_min > 0 (only when not NULL)
--     workout_sessions.duration_min is nullable (ongoing session or not
--     tracked). When a value is recorded it must be positive.
--
-- Canary safety: CHECK constraints on existing columns perform a full-table
-- scan during ADD CONSTRAINT but hold only a SHARE ROW EXCLUSIVE lock for
-- the duration of the scan. On the empty/tiny datasets we have (no prod
-- traffic yet), the lock window is negligible. All existing seed data
-- satisfies these bounds so no existing rows will be rejected.
--
-- NOT VALID + VALIDATE CONSTRAINT (the online-safe pattern for large tables)
-- is intentionally skipped here: the table is pre-production with negligible
-- row count, making the lock window immaterial. These statements also run
-- inside a transaction, so a crash rolls back the whole migration atomically —
-- idempotence is handled by the transaction, not by individual statement guards.

ALTER TABLE "classes"
    ADD CONSTRAINT "classes_capacity_positive" CHECK (capacity > 0),
    ADD CONSTRAINT "classes_capacity_max" CHECK (capacity <= 10000),
    ADD CONSTRAINT "classes_duration_min_positive" CHECK (duration_min > 0),
    ADD CONSTRAINT "classes_duration_min_max" CHECK (duration_min <= 1440);

ALTER TABLE "workout_sessions"
    ADD CONSTRAINT "workout_sessions_duration_min_positive"
        CHECK (duration_min IS NULL OR duration_min > 0);
