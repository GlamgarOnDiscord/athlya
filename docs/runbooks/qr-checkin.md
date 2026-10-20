# QR check-in

How a member checks in at the front desk, and what has to be in place for
it to work in a deployed environment.

## Flow

1. The member opens the check-in code: `/checkin` in the mobile app, or
   `/me/checkin` on the web. Either one calls `POST /v1/checkins/token`
   and renders the returned token as a QR code (encoder:
   `qrcode-generator`, level M). The token is a single-use RS256 JWT valid
   120 s; both clients fetch the next one 15 s before expiry, and only while
   the screen or tab is in use.
2. An admin or a coach opens the kiosk at `/dashboard/checkin` in the studio
   app (a coach can open no other dashboard page) and scans the code. The
   kiosk uses the native `BarcodeDetector` when the browser reads QR codes
   with it, and the `jsqr` decoder on a canvas otherwise (Firefox, Safari,
   most desktop Chrome builds), at about 8 frames per second. The token can
   also be pasted by hand.
3. `POST /v1/checkins` verifies the signature, kind, studio and validity
   window, records the `jti` (anti-replay), and stamps the reservation whose
   class starts within ±30 min.

## Operator checklist

- **Signing keys on `athlya-api-reservations`.** `JWT_KID`,
  `JWT_PRIVATE_KEY_PEM`, `JWT_PUBLIC_KEY_PEM` (and `JWKS_JSON` during a key
  rotation) must be the same values as on the auth Worker. A deployed Worker
  without them refuses to serve check-ins.
  `node scripts/verify-secrets.mjs --env production` lists what
  is missing.
- **Redis.** `REDIS_URL` and `REDIS_TOKEN` back the anti-replay set; without
  Redis a check-in fails closed.
- **Migration `0045_checkin_runtime.sql`** applied to the target database
  (`checkin_mark_reservation`, the hourly limit).
- **Camera.** The studio app sends `Permissions-Policy: camera=(self)` on
  `/dashboard/checkin` only and `camera=()` everywhere else
  (`apps/studio/next.config.ts`). The kiosk must be served over HTTPS, and
  the browser asks the operator once for camera access. When access is
  refused, the kiosk says so and keeps the manual entry.

## Kiosk messages

| API code                | Meaning                                                |
| ----------------------- | ------------------------------------------------------ |
| `token_expired`         | The member shows an old code: ask for a fresh one.     |
| `replay`                | The code was already used.                             |
| `wrong_studio`          | The member's session belongs to another studio.        |
| `outside_window`        | No class of the member starts within ±30 min.          |
| `no_reservation`        | No confirmed reservation for the member.               |
| `already_checked_in`    | The member is already checked in for that class.       |
| `checkin_limit_reached` | More than 5 check-ins for the member in the last hour. |

## Third-party code

| Package            | Where          | Licence    |
| ------------------ | -------------- | ---------- |
| `qrcode-generator` | web, mobile    | MIT        |
| `jsqr`             | studio (kiosk) | Apache-2.0 |
