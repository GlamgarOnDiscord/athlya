-- Stripe webhook idempotency (issue #69)
-- Dedup Stripe `event.id` before publishing to the event bus.

CREATE TABLE "stripe_webhook_events" (
    "event_id" text PRIMARY KEY,
    "event_type" text NOT NULL,
    "processed_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX "stripe_webhook_events_processed_at_idx"
    ON "stripe_webhook_events" ("processed_at");--> statement-breakpoint

GRANT INSERT, SELECT ON "stripe_webhook_events" TO athlya_app;
