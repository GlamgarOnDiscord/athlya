-- =====================================================================
-- Athlya Platform — export_jobs table migration (0002_export_jobs)
--
-- Task 5.3 / Requirements 4.1–4.4.
--
-- Adds:
--   1. The `export_job_status` enum type: ('pending', 'running',
--      'completed', 'failed').
--   2. The `export_jobs` table tracking RGPD data-export lifecycle.
--   3. A partial index on `(user_id, requested_at)` scoped to the
--      pending / running slice so the dedup query in
--      `enqueueExport` (packages/members/src/export.ts) runs in O(1).
--   4. RLS: members can see their own jobs; the background worker
--      runs under a BYPASSRLS service role (per the convention
--      established by 0001_rls.sql for outbox / audit consumers) so
--      no mutation policy is granted to application roles.
--
-- All statements use `IF NOT EXISTS` / `DROP POLICY IF EXISTS` so this
-- migration is safely re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Enum type
-- ---------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'export_job_status'
    ) THEN
        CREATE TYPE "public"."export_job_status"
            AS ENUM ('pending', 'running', 'completed', 'failed');
    END IF;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 2. Table
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "export_jobs" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "user_id" uuid NOT NULL,
    "status" "public"."export_job_status" NOT NULL DEFAULT 'pending',
    "requested_at" timestamp with time zone NOT NULL DEFAULT now(),
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "error" text,
    "download_url" text,
    "download_expires_at" timestamp with time zone,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "export_jobs_user_id_users_id_fk"
        FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
);
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 3. Partial index on the active slice (pending / running)
-- ---------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "export_jobs_user_active_idx"
    ON "export_jobs" ("user_id", "requested_at")
    WHERE status IN ('pending', 'running');
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 4. RLS
--
-- The RGPD export is a personal action: a user must see their own
-- jobs (to poll the status) and nothing else. Mutations are performed
-- by the background worker under a BYPASSRLS service role, so no
-- INSERT / UPDATE policy is granted to application roles — forgery
-- protection matches the posture taken by `audit_log` and `outbox`
-- in 0001_rls.sql.
-- ---------------------------------------------------------------------

ALTER TABLE "export_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "export_jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "export_jobs_read_own" ON "export_jobs";--> statement-breakpoint
CREATE POLICY "export_jobs_read_own" ON "export_jobs"
    FOR SELECT
    USING (user_id = public.app_user_id());
--> statement-breakpoint
