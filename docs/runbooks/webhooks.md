# Studio settings and webhooks

Issues #759 and #760, migration `0053_studio_settings_webhooks.sql`.

## Studio settings

Configuration, Studio settings (`/dashboard/settings`, admins): name, IANA
time zone, postal address, contact email. API:
`GET` and `PATCH /v1/studios/me/settings`. The write uses the existing
`studios_admin_update_own` policy and a column-scoped grant. The
cancellation window stays the fixed 2 hours of `@athlya/reservations`
(`CANCELLATION_WINDOW_MS`); the page states it, nothing stores it per
studio yet.

## Webhooks

Configuration, Integrations (`/dashboard/integrations`, admins). An
endpoint is a public HTTPS URL (no IP literal, no local or reserved host
name, no credentials), 1 to 5 event types, and a signing secret
`whsec_...` shown once at creation and at each rotation. 10 endpoints per
studio.

Events: `reservation.created`, `reservation.waitlisted`,
`reservation.cancelled`, `reservation.promoted`, `auth.user.registered`.

How a delivery happens:

1. A domain write inserts its event in `outbox` (transactional publish).
   The `outbox_enqueue_webhooks` trigger adds one `webhook_deliveries` row
   per enabled endpoint of the studio subscribed to the type, in the same
   transaction. A trigger failure is logged as a warning and never blocks
   the write. Events published without the outbox are not delivered.
2. The minute cron of the gateway Worker (`athlya_cron`, `CRON_DB_URL`)
   calls `webhook_claim_deliveries(20)` (2-minute lease), posts each one
   (10 s timeout, redirects not followed) and records the outcome with
   `webhook_record_attempt`.
3. 2xx: delivered. Otherwise retried after 1 min, 5 min, 30 min, 2 h and
   6 h; failed after the sixth attempt. A paused endpoint keeps its
   pending deliveries and sends them when enabled again. Finished
   deliveries are purged after 30 days.

Request:

```
POST <url>
content-type: application/json
athlya-event: reservation.created
athlya-delivery: <delivery id, stable across retries>
athlya-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>

{"id":"<event id>","type":"reservation.created","occurredAt":"...","data":{...}}
```

The receiver recomputes the HMAC on the raw body, compares in constant
time, refuses a `t` older than 5 minutes and deduplicates on `id`.

The secret is stored in `webhook_endpoints.secret`, which `athlya_app` can
write but not read; only the cron claim returns it. It is not encrypted
with an application key (open question in the PR).

## Operator steps

- Apply migration 0053 before deploying the Workers (expand only):
  `node packages/db/scripts/migrate.mjs`. Rollback:
  `0053_studio_settings_webhooks.down.sql` (drops endpoints, deliveries
  and the settings columns).
- The gateway Worker must have `CRON_DB_URL` (athlya_cron); without it no
  delivery is sent and the endpoints only accumulate pending rows.
