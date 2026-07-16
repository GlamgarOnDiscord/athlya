-- =====================================================================
-- run-all.sql — entry point for the pgTAP RLS suite (task 2.6)
--
-- Source order:
--   1. 00_bootstrap.sql installs the `pgtap` extension, seeds two
--      studios / six users / deterministic rows, and declares the
--      `test_set_tenant` / `test_unset_tenant` helper functions.
--   2. Each per-table file runs in its own transaction rolled back at
--      the end, so a second invocation in the same psql session
--      operates against identical seed data.
--
-- Usage:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--        -f migrations/0000_init.sql \
--        -f migrations/0001_rls.sql \
--        -f tests/rls/run-all.sql
-- =====================================================================

\set ON_ERROR_STOP on

-- 1. Bootstrap (extensions, seed data, helpers)
\i tests/rls/00_bootstrap.sql

-- 2. Per-table test files
\i tests/rls/studios.sql
\i tests/rls/users.sql
\i tests/rls/classes.sql
\i tests/rls/reservations.sql
\i tests/rls/capacity_guard.sql
\i tests/rls/workout_sessions.sql
\i tests/rls/audit_log.sql
\i tests/rls/audit_anonymization.sql
\i tests/rls/audit_anonymization_scalar_guard.sql
\i tests/rls/push_tokens.sql
\i tests/rls/idempotency_keys.sql
\i tests/rls/outbox.sql
\i tests/rls/export_jobs.sql
\i tests/rls/email_partial_unique.sql
\i tests/rls/password_reset_one_active.sql
\i tests/rls/cron_role.sql
\i tests/rls/constraints.sql
