-- =====================================================================
-- 0051: studio rooms, recurring class series and the indexes behind
-- schedule conflict detection (issue #748, roadmap v1.4)
--
-- 1. `rooms`: the places of a studio where classes run. A name, an
--    optional capacity (1..500, a hint the planning uses as the default
--    class capacity) and a soft delete. A live name is unique per studio
--    regardless of case. The composite `(id, studio_id)` key lets
--    `classes` reference a room of its own studio only: FK checks bypass
--    RLS, the composite key does not.
--
-- 2. `classes.room_id`: the room a class runs in, nullable (a class may
--    have no room). Composite FK to `rooms(id, studio_id)`; a hard
--    delete of a room (only the studio cascade does one) clears the
--    room column alone, `studio_id` is left untouched.
--
-- 3. `classes.series_id`: groups the occurrences created together by a
--    weekly repetition. No table behind it: a series is the set of its
--    live classes, each occurrence stays an ordinary class with its own
--    version, capacity and bookings.
--
-- 4. Indexes for the overlap lookups the API runs before creating or
--    moving a class: live classes by room and by coach, ordered by
--    start, and the occurrences of a series by start.
--
-- RLS (Req 13.2, 13.6): ENABLE + FORCE on `rooms`, policies mirroring
-- `classes`: every role of the studio reads its rooms, only an admin
-- of the studio creates or updates one. Rooms are never hard-deleted
-- at runtime (the API stamps `deleted_at`), so there is no DELETE grant
-- and no DELETE policy. Grants: `athlya_app` only, UPDATE limited to
-- the mutable columns. `athlya_cron` gets nothing. No function, so no
-- SECURITY DEFINER surface.
--
-- `classes` keeps its grants (table-wide DML for athlya_app since
-- 0004), which cover the two new columns.
--
-- Plain (non-CONCURRENTLY) index builds keep the whole step in one
-- transaction, like 0044: `classes` is small, the pause stays short.
--
-- Expand only: one new table, two nullable columns, a FK that only
-- checks non-null values, indexes and policies. An old Worker neither
-- reads nor writes the new columns, so it runs unchanged against this
-- schema during the canary. The new Worker selects them: apply this
-- migration BEFORE deploying the reservations Worker.
-- =====================================================================

CREATE TABLE IF NOT EXISTS "rooms" (
    "id" uuid PRIMARY KEY DEFAULT gen_uuid_v7() NOT NULL,
    "studio_id" uuid NOT NULL REFERENCES "studios"("id") ON DELETE CASCADE,
    "name" text NOT NULL,
    "capacity" integer,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "deleted_at" timestamptz,
    CONSTRAINT "rooms_id_studio_unique" UNIQUE ("id", "studio_id"),
    CONSTRAINT "rooms_name_length" CHECK (char_length(btrim("name")) BETWEEN 1 AND 80),
    CONSTRAINT "rooms_capacity_range" CHECK ("capacity" IS NULL OR "capacity" BETWEEN 1 AND 500)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "rooms_studio_name_live_unique"
    ON "rooms" ("studio_id", lower("name"))
    WHERE "deleted_at" IS NULL;
--> statement-breakpoint

ALTER TABLE "classes" ADD COLUMN IF NOT EXISTS "room_id" uuid;--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN IF NOT EXISTS "series_id" uuid;--> statement-breakpoint

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'classes_room_fk'
    ) THEN
        ALTER TABLE "classes"
            ADD CONSTRAINT "classes_room_fk" FOREIGN KEY ("room_id", "studio_id")
            REFERENCES "rooms"("id", "studio_id") ON DELETE SET NULL ("room_id");
    END IF;
END
$$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "classes_room_starts_at_idx"
    ON "classes" ("room_id", "starts_at")
    WHERE "room_id" IS NOT NULL AND "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "classes_coach_starts_at_idx"
    ON "classes" ("coach_id", "starts_at")
    WHERE "coach_id" IS NOT NULL AND "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "classes_series_starts_at_idx"
    ON "classes" ("series_id", "starts_at")
    WHERE "series_id" IS NOT NULL AND "deleted_at" IS NULL;
--> statement-breakpoint

ALTER TABLE "rooms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rooms" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "rooms_read_same_studio" ON "rooms";--> statement-breakpoint
CREATE POLICY "rooms_read_same_studio" ON "rooms"
    FOR SELECT
    USING (studio_id = public.app_studio_id());
--> statement-breakpoint

DROP POLICY IF EXISTS "rooms_insert_admin" ON "rooms";--> statement-breakpoint
CREATE POLICY "rooms_insert_admin" ON "rooms"
    FOR INSERT
    WITH CHECK (
        studio_id = public.app_studio_id()
        AND public.app_role() = 'admin'
    );
--> statement-breakpoint

DROP POLICY IF EXISTS "rooms_update_admin" ON "rooms";--> statement-breakpoint
CREATE POLICY "rooms_update_admin" ON "rooms"
    FOR UPDATE
    USING (
        studio_id = public.app_studio_id()
        AND public.app_role() = 'admin'
    )
    WITH CHECK (
        studio_id = public.app_studio_id()
        AND public.app_role() = 'admin'
    );
--> statement-breakpoint

GRANT SELECT, INSERT ON "rooms" TO athlya_app;--> statement-breakpoint
GRANT UPDATE ("name", "capacity", "deleted_at") ON "rooms" TO athlya_app;
