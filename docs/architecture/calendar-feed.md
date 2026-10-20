# Member calendar feed

Issue #719. A member adds a booked class to their own calendar (one event) or subscribes once to a
feed that keeps every booking in sync. No migration, no change to auth or billing.

## Surfaces

| Surface                            | Where                                  | What                                                                                                     |
| ---------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| "Ajouter au calendrier"            | Confirmed class card, `/me` bookings   | One-event `.ics` built in the browser, plus a Google Calendar template link. Nothing is sent to the API. |
| `GET /v1/calendar/feed-url`        | Gateway, `jwtAuth` + `studioRateLimit` | The member's subscription URL, as `https://` and `webcal://`. `Cache-Control: private, no-store`.        |
| `GET /v1/calendar/feed.ics?token=` | Gateway, public                        | RFC 5545 feed, `text/calendar; charset=utf-8`, `Cache-Control: private, max-age=300`, ETag and 304.      |

The serializer is shared (`@athlya/shared/calendar`), so the one-off download and the feed write the
same event for a booking: UTC `DTSTART`/`DTEND` (no `VTIMEZONE`), TEXT escaping, 75-octet folding
that never splits a UTF-8 character, CRLF line breaks.

## Token

`token = base64url(payload) "." base64url(HMAC-SHA256(key, "athlya-calendar-feed:" + payload))`
with `payload = "v1.<memberId>.<studioId>.<credentialsVersion>"` and `key =
CALENDAR_FEED_SIGNING_KEY` (gateway secret, at least 32 characters).

- **Stateless**: nothing is stored. The MAC is checked with `crypto.subtle.verify` (constant time)
  before the payload is parsed.
- **Bound to the member's credentials**: `credentialsVersion` is `users.credentials_version`, which
  logout from all devices, a password reset or a role or studio change already bump. The feed
  answers 404 as soon as it no longer matches, so those events revoke the member's feed too.
- **Global revocation**: rotating `CALENDAR_FEED_SIGNING_KEY` revokes every feed at once
  ([`rotate-secrets.md`](../runbooks/rotate-secrets.md)). Without the key both routes answer 503
  `calendar_feed_not_configured`.
- **Indistinct failures**: a malformed, forged, foreign-key or outdated token, a deleted member or
  a studio mismatch all answer the same 404.
- **Out of the application logs**: the token travels in the query string. The serve log, the OTel
  span and the Sentry tags record the pathname only. Cloudflare's own request logs still see the
  full URL: an accepted trade-off (owner decision, 2026-10-20), since calendar clients subscribe to
  a plain URL and send no headers. A token copied from a log is read-only, scoped to one member,
  and dies with a credential bump or a key rotation.

## Data and tenant isolation

The feed reads through `withTenantHttp` with claims built from the verified token and the
`member` role, so the `users_read_own`, `reservations_read_own`, `classes_read_same_studio` and
`studios_read_own_tenant` policies apply under `athlya_app` (NOBYPASSRLS). A token minted for an
admin still reads that person's own bookings only. Covered by
`calendar-feed-repo.pglite.test.ts` on the real migration chain.

Content, one round trip:

- bookings whose class starts between 7 days ago and 90 days ahead, at most 500;
- `confirmed` as `STATUS:CONFIRMED`; `cancelled`, or confirmed on a deleted class, as
  `STATUS:CANCELLED`. A cancelled booking superseded by a new booking of the same class is dropped;
- **waitlist entries are left out**: the seat is not the member's yet. A promotion turns the row
  into a confirmed booking, which the next poll picks up;
- per event: class title (`SUMMARY`), studio name (`LOCATION`, there is no address column),
  start and end in UTC, `UID` `reservation-<id>@athlya.app` (stable per booking), `DTSTAMP` (last
  change of the booking), `SEQUENCE` (`classes.version`, plus one once cancelled). No member name,
  email or id is written in the body.

## Limits

- Rate limit `calendar-feed`: 60 requests per minute per IP, fail-closed, own Redis namespace
  ([`rate-limit-coverage.md`](../security/rate-limit-coverage.md)). Above the expensive-read budget
  because calendar providers poll from shared IPs; a 429 only delays a refresh.
- Refresh hints `REFRESH-INTERVAL` and `X-PUBLISHED-TTL` of one hour. Google Calendar polls on its
  own schedule (several hours), so a change can take that long to show there.
- Served by the gateway only: `/v1/calendar/*` matches no bulkhead route, so no wrangler route
  changes.
- One URL per member and credentials version: there is no per-feed revocation that keeps the
  session alive (it would need a stored column, so a migration).

## Later

- Two-way Google Calendar sync (OAuth, writes to the member's calendar) is out of scope.
- Studio address in `LOCATION` once studios carry one.
