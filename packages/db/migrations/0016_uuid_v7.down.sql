-- Revert 0016: restore gen_random_uuid() defaults and drop gen_uuid_v7().

ALTER TABLE "workout_sessions"       ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "users"                  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "studios"                ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "reservations"           ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "push_tokens"            ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "password_reset_tokens"  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "outbox"                 ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "export_jobs"            ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "classes"                ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

DROP FUNCTION IF EXISTS gen_uuid_v7();
