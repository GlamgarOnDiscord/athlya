-- Migration 0022 — Tighten reservations INSERT RLS to enforce studio ownership
--
-- The original reservations_insert_own policy only checked that the
-- inserted user_id equals app_user_id(). A member could insert a
-- reservation row against a class from a foreign studio if they had a
-- runtime token for their own user. The app-layer guards reduce
-- exploitability but the database is the final isolation boundary.
--
-- This migration replaces the policy with one that also verifies the
-- class belongs to the calling user's studio.
--
-- Safe for canary: tightening a WITH CHECK policy only rejects
-- previously-impermissible inserts. All valid same-studio bookings
-- continue to pass. No column or index changes.

DROP POLICY IF EXISTS "reservations_insert_own" ON "reservations";--> statement-breakpoint
CREATE POLICY "reservations_insert_own" ON "reservations"
    FOR INSERT
    WITH CHECK (
        user_id = public.app_user_id()
        AND EXISTS (
            SELECT 1
            FROM "classes" c
            WHERE c.id = "reservations".class_id
              AND c.studio_id = public.app_studio_id()
        )
    );
