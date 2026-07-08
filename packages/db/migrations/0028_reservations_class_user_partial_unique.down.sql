DROP INDEX IF EXISTS "reservations_class_user_active_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_class_user_unique"
    ON "reservations" ("class_id", "user_id");
