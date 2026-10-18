-- Rollback for 0042_training_programs.sql (Epic 24, issue #640).
-- Dropping the tables also drops their policies, grants and the
-- subscription trigger; the functions and the status type go last.
DROP FUNCTION IF EXISTS rgpd_delete_program_subscriptions(uuid);
-- `programs_read_member` reads `program_subscriptions`: drop it first.
DROP POLICY IF EXISTS "programs_read_member" ON "programs";
DROP TABLE IF EXISTS "program_subscriptions";
DROP TABLE IF EXISTS "program_workouts";
DROP TABLE IF EXISTS "program_weeks";
DROP TABLE IF EXISTS "programs";
DROP FUNCTION IF EXISTS enforce_program_subscribable();
DROP TYPE IF EXISTS "program_status";
