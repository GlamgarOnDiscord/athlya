-- =====================================================================
-- 0042 — training programs (Epic 24, tasks 24.1 / 24.2, issue #640)
--
-- Four new tenant tables:
--
--   programs               a studio's multi-week training plan
--                          (`draft` → `published` → `archived`)
--   program_weeks          one row per week of a program (1-based)
--   program_workouts       the workout prescribed on day 1..7 of a week,
--                          exercises in a bounded jsonb array
--   program_subscriptions  a user following a program from `starts_on`;
--                          unsubscribing stamps `cancelled_at`
--
-- Every child row carries `studio_id` and references its parent through
-- the composite `(id, studio_id)` key, so a week, a workout or a
-- subscription cannot point at another studio's program even if a
-- caller forges the parent id (FK checks bypass RLS, the composite key
-- does not).
--
-- RLS (Req 13.2, 13.6): ENABLE + FORCE on every table, policies scoped
-- by `app_studio_id()` and the role / user claims:
--
--   - admins and coaches read every program of their studio; members
--     read published programs and the ones they actively follow (an
--     archived program stays readable to its subscribers);
--   - weeks and workouts inherit the visibility of their program (the
--     policy subquery runs under the caller's RLS on `programs`);
--   - only admins insert / update programs and replace weeks / workouts;
--   - a user reads, creates and cancels only their own subscriptions.
--     `program_subscriptions` policies never reference `programs`, so
--     the `programs` read policy that looks at subscriptions cannot
--     recurse. Subscribing to a non-published program is refused by the
--     `enforce_program_subscribable` trigger instead, which runs as the
--     caller (SECURITY INVOKER): a member does not see drafts, so the
--     same RLS decides.
--
-- Grants follow 0036–0041: explicit, least privilege, `athlya_app` only.
-- No DELETE on `programs` (archive is an UPDATE), no DELETE on
-- `program_subscriptions` (unsubscribe is an UPDATE of `cancelled_at`).
-- `athlya_cron` gets nothing: no maintenance job reads these tables.
--
-- RGPD Article 17: subscriptions are personal data. The account-deletion
-- cascade runs claim-less under `athlya_app`, so it purges them through
-- `rgpd_delete_program_subscriptions(uuid)` — SECURITY DEFINER, owned by
-- `athlya_owner`, pinned search_path, EXECUTE for `athlya_app` only, and
-- a no-op for a live account (same guard as the 0032 `rgpd_*` family).
--
-- Expand only: new type, tables, policies, one trigger and one function.
-- Old Workers never touch these tables, so the canary is safe.
-- =====================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'program_status') THEN
        CREATE TYPE "program_status" AS ENUM ('draft', 'published', 'archived');
    END IF;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "programs" (
    "id" uuid PRIMARY KEY DEFAULT gen_uuid_v7() NOT NULL,
    "studio_id" uuid NOT NULL REFERENCES "studios"("id") ON DELETE CASCADE,
    "title" text NOT NULL,
    "description" text,
    "status" "program_status" DEFAULT 'draft' NOT NULL,
    "version" integer DEFAULT 0 NOT NULL,
    "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL,
    "archived_at" timestamptz,
    CONSTRAINT "programs_id_studio_unique" UNIQUE ("id", "studio_id"),
    CONSTRAINT "programs_title_length" CHECK (char_length("title") BETWEEN 1 AND 120),
    CONSTRAINT "programs_description_length"
        CHECK ("description" IS NULL OR char_length("description") <= 2000),
    CONSTRAINT "programs_archived_consistency"
        CHECK (("status" = 'archived') = ("archived_at" IS NOT NULL))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "programs_studio_status_idx" ON "programs" ("studio_id", "status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "program_weeks" (
    "id" uuid PRIMARY KEY DEFAULT gen_uuid_v7() NOT NULL,
    "program_id" uuid NOT NULL,
    "studio_id" uuid NOT NULL,
    "week_number" smallint NOT NULL,
    "title" text,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT "program_weeks_program_fk" FOREIGN KEY ("program_id", "studio_id")
        REFERENCES "programs"("id", "studio_id") ON DELETE CASCADE,
    CONSTRAINT "program_weeks_id_studio_unique" UNIQUE ("id", "studio_id"),
    CONSTRAINT "program_weeks_program_week_unique" UNIQUE ("program_id", "week_number"),
    CONSTRAINT "program_weeks_week_number_range" CHECK ("week_number" BETWEEN 1 AND 52),
    CONSTRAINT "program_weeks_title_length"
        CHECK ("title" IS NULL OR char_length("title") <= 120)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "program_workouts" (
    "id" uuid PRIMARY KEY DEFAULT gen_uuid_v7() NOT NULL,
    "week_id" uuid NOT NULL,
    "studio_id" uuid NOT NULL,
    "day_number" smallint NOT NULL,
    "title" text NOT NULL,
    "notes" text,
    "exercises" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT "program_workouts_week_fk" FOREIGN KEY ("week_id", "studio_id")
        REFERENCES "program_weeks"("id", "studio_id") ON DELETE CASCADE,
    CONSTRAINT "program_workouts_week_day_unique" UNIQUE ("week_id", "day_number"),
    CONSTRAINT "program_workouts_day_number_range" CHECK ("day_number" BETWEEN 1 AND 7),
    CONSTRAINT "program_workouts_title_length" CHECK (char_length("title") BETWEEN 1 AND 120),
    CONSTRAINT "program_workouts_notes_length"
        CHECK ("notes" IS NULL OR char_length("notes") <= 2000),
    CONSTRAINT "program_workouts_exercises_array"
        CHECK (jsonb_typeof("exercises") = 'array' AND jsonb_array_length("exercises") <= 30)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "program_subscriptions" (
    "id" uuid PRIMARY KEY DEFAULT gen_uuid_v7() NOT NULL,
    "program_id" uuid NOT NULL,
    "studio_id" uuid NOT NULL,
    "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "starts_on" date NOT NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "cancelled_at" timestamptz,
    CONSTRAINT "program_subscriptions_program_fk" FOREIGN KEY ("program_id", "studio_id")
        REFERENCES "programs"("id", "studio_id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "program_subscriptions_user_program_active_unique"
    ON "program_subscriptions" ("user_id", "program_id")
    WHERE cancelled_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "program_subscriptions_program_idx"
    ON "program_subscriptions" ("program_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 2. Row-level security
-- ---------------------------------------------------------------------

ALTER TABLE "programs"              ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "programs"              FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "program_weeks"         ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "program_weeks"         FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "program_workouts"      ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "program_workouts"      FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "program_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "program_subscriptions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- programs ------------------------------------------------------------

DROP POLICY IF EXISTS "programs_read_staff" ON "programs";--> statement-breakpoint
CREATE POLICY "programs_read_staff" ON "programs"
    FOR SELECT
    USING (studio_id = public.app_studio_id() AND public.app_role() IN ('admin', 'coach'));
--> statement-breakpoint

DROP POLICY IF EXISTS "programs_read_member" ON "programs";--> statement-breakpoint
CREATE POLICY "programs_read_member" ON "programs"
    FOR SELECT
    USING (
        studio_id = public.app_studio_id()
        AND (
            status = 'published'
            OR EXISTS (
                SELECT 1
                  FROM program_subscriptions s
                 WHERE s.program_id = programs.id
                   AND s.user_id = public.app_user_id()
                   AND s.cancelled_at IS NULL
            )
        )
    );
--> statement-breakpoint

DROP POLICY IF EXISTS "programs_admin_insert" ON "programs";--> statement-breakpoint
CREATE POLICY "programs_admin_insert" ON "programs"
    FOR INSERT
    WITH CHECK (studio_id = public.app_studio_id() AND public.app_role() = 'admin');
--> statement-breakpoint

DROP POLICY IF EXISTS "programs_admin_update" ON "programs";--> statement-breakpoint
CREATE POLICY "programs_admin_update" ON "programs"
    FOR UPDATE
    USING (studio_id = public.app_studio_id() AND public.app_role() = 'admin')
    WITH CHECK (studio_id = public.app_studio_id() AND public.app_role() = 'admin');
--> statement-breakpoint

-- program_weeks -------------------------------------------------------

DROP POLICY IF EXISTS "program_weeks_read_visible" ON "program_weeks";--> statement-breakpoint
CREATE POLICY "program_weeks_read_visible" ON "program_weeks"
    FOR SELECT
    USING (
        studio_id = public.app_studio_id()
        AND EXISTS (SELECT 1 FROM programs p WHERE p.id = program_weeks.program_id)
    );
--> statement-breakpoint

DROP POLICY IF EXISTS "program_weeks_admin_insert" ON "program_weeks";--> statement-breakpoint
CREATE POLICY "program_weeks_admin_insert" ON "program_weeks"
    FOR INSERT
    WITH CHECK (studio_id = public.app_studio_id() AND public.app_role() = 'admin');
--> statement-breakpoint

DROP POLICY IF EXISTS "program_weeks_admin_delete" ON "program_weeks";--> statement-breakpoint
CREATE POLICY "program_weeks_admin_delete" ON "program_weeks"
    FOR DELETE
    USING (studio_id = public.app_studio_id() AND public.app_role() = 'admin');
--> statement-breakpoint

-- program_workouts ----------------------------------------------------

DROP POLICY IF EXISTS "program_workouts_read_visible" ON "program_workouts";--> statement-breakpoint
CREATE POLICY "program_workouts_read_visible" ON "program_workouts"
    FOR SELECT
    USING (
        studio_id = public.app_studio_id()
        AND EXISTS (SELECT 1 FROM program_weeks w WHERE w.id = program_workouts.week_id)
    );
--> statement-breakpoint

DROP POLICY IF EXISTS "program_workouts_admin_insert" ON "program_workouts";--> statement-breakpoint
CREATE POLICY "program_workouts_admin_insert" ON "program_workouts"
    FOR INSERT
    WITH CHECK (studio_id = public.app_studio_id() AND public.app_role() = 'admin');
--> statement-breakpoint

DROP POLICY IF EXISTS "program_workouts_admin_delete" ON "program_workouts";--> statement-breakpoint
CREATE POLICY "program_workouts_admin_delete" ON "program_workouts"
    FOR DELETE
    USING (studio_id = public.app_studio_id() AND public.app_role() = 'admin');
--> statement-breakpoint

-- program_subscriptions -----------------------------------------------

DROP POLICY IF EXISTS "program_subscriptions_read_own" ON "program_subscriptions";--> statement-breakpoint
CREATE POLICY "program_subscriptions_read_own" ON "program_subscriptions"
    FOR SELECT
    USING (studio_id = public.app_studio_id() AND user_id = public.app_user_id());
--> statement-breakpoint

DROP POLICY IF EXISTS "program_subscriptions_insert_own" ON "program_subscriptions";--> statement-breakpoint
CREATE POLICY "program_subscriptions_insert_own" ON "program_subscriptions"
    FOR INSERT
    WITH CHECK (
        studio_id = public.app_studio_id()
        AND user_id = public.app_user_id()
        AND cancelled_at IS NULL
    );
--> statement-breakpoint

DROP POLICY IF EXISTS "program_subscriptions_cancel_own" ON "program_subscriptions";--> statement-breakpoint
CREATE POLICY "program_subscriptions_cancel_own" ON "program_subscriptions"
    FOR UPDATE
    USING (studio_id = public.app_studio_id() AND user_id = public.app_user_id())
    WITH CHECK (studio_id = public.app_studio_id() AND user_id = public.app_user_id());
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 3. Only published programs accept new subscriptions
--
-- SECURITY INVOKER on purpose: the lookup runs under the caller's RLS,
-- so a member cannot subscribe to a draft they cannot see, and nobody
-- can subscribe to a program that is archived or still a draft.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_program_subscribable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM programs p
         WHERE p.id = NEW.program_id
           AND p.studio_id = NEW.studio_id
           AND p.status = 'published'
    ) THEN
        RAISE EXCEPTION 'program_not_subscribable'
            USING ERRCODE = 'P0001',
                  DETAIL = 'only a published program of the caller''s studio accepts subscriptions';
    END IF;
    RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "program_subscriptions_subscribable" ON "program_subscriptions";--> statement-breakpoint
CREATE TRIGGER "program_subscriptions_subscribable"
    BEFORE INSERT ON "program_subscriptions"
    FOR EACH ROW EXECUTE FUNCTION enforce_program_subscribable();
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 4. Grants (athlya_app only)
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT ON "programs" TO athlya_app;--> statement-breakpoint
GRANT UPDATE ("title", "description", "status", "version", "updated_at", "archived_at")
    ON "programs" TO athlya_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "program_weeks" TO athlya_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "program_workouts" TO athlya_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "program_subscriptions" TO athlya_app;--> statement-breakpoint
GRANT UPDATE ("cancelled_at") ON "program_subscriptions" TO athlya_app;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 5. RGPD Article 17 — purge a deleted user's subscriptions
-- ---------------------------------------------------------------------

GRANT SELECT, DELETE ON "program_subscriptions" TO athlya_owner;--> statement-breakpoint

CREATE OR REPLACE FUNCTION rgpd_delete_program_subscriptions(p_user_id uuid)
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH d AS (
        DELETE FROM program_subscriptions s
         WHERE s.user_id = p_user_id
           AND EXISTS (SELECT 1 FROM users u WHERE u.id = p_user_id AND u.deleted_at IS NOT NULL)
        RETURNING 1
    )
    SELECT count(*)::integer FROM d
$$;
--> statement-breakpoint

ALTER FUNCTION rgpd_delete_program_subscriptions(uuid) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION rgpd_delete_program_subscriptions(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rgpd_delete_program_subscriptions(uuid) TO athlya_app;
