-- Issue #468: make the anti-double-booking unique index partial so that a
-- cancelled reservation does not block the user from re-booking the same class.
--
-- The old global unique index fired on (class_id, user_id) regardless of
-- status. A cancelled row therefore produced a UniqueViolationError on
-- rebook, which the service erroneously surfaced as `already_booked`.
--
-- The new partial index covers only the active statuses: 'confirmed' and
-- 'waitlist'. Cancelled rows are excluded, so an INSERT on rebook
-- succeeds outright rather than bouncing through the idempotency branch.

DROP INDEX IF EXISTS "reservations_class_user_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_class_user_active_unique"
    ON "reservations" ("class_id", "user_id")
    WHERE status IN ('confirmed', 'waitlist');
