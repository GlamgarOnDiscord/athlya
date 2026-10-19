-- =====================================================================
-- 0048 — imported workout sessions (task 18.1, issue #688)
--
-- The mobile app imports Apple Health workouts as sessions. Each one
-- carries the app it comes from (`source`) and the workout id there
-- (`external_id`, the HealthKit workout UUID). The partial unique index
-- keeps one session per (user, source, external_id): importing the same
-- workout again, from a reinstalled app or another device, inserts
-- nothing and the API returns the existing session.
--
-- Expand only: both columns are nullable with no default and old Workers
-- never write them, so their inserts keep working during the canary.
-- Sessions logged in Athlya keep both NULL and stay outside the index.
-- The CHECKs only constrain non-NULL values, so every existing row
-- passes them. The owner-only RLS policies of 0001 cover the new
-- columns unchanged.
--
-- Numbered 0048 because 0046 and 0047 are claimed by the cardio
-- metrics change (#684) and the idempotency key purge (#689); the
-- migrator tracks applied files by name, so they apply in any order.
-- =====================================================================

ALTER TABLE "workout_sessions" ADD COLUMN IF NOT EXISTS "source" text;--> statement-breakpoint
ALTER TABLE "workout_sessions" ADD COLUMN IF NOT EXISTS "external_id" text;--> statement-breakpoint

ALTER TABLE "workout_sessions"
    ADD CONSTRAINT "workout_sessions_source_known"
    CHECK ("source" IN ('appleHealth'));--> statement-breakpoint

ALTER TABLE "workout_sessions"
    ADD CONSTRAINT "workout_sessions_source_pair"
    CHECK (("source" IS NULL) = ("external_id" IS NULL));--> statement-breakpoint

ALTER TABLE "workout_sessions"
    ADD CONSTRAINT "workout_sessions_external_id_length"
    CHECK (char_length("external_id") BETWEEN 1 AND 128);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "workout_sessions_user_source_external_id_uniq"
    ON "workout_sessions" ("user_id", "source", "external_id")
    WHERE "external_id" IS NOT NULL;
