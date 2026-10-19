# Mobile — Epic 10 (`apps/mobile`)

**Status**: foundation (issue #638), member screens (issue #647) and the QR check-in screen (issue
#648) delivered, 13/13 tasks; progression graphs (22.2, issue #660) too. Sign-in and registration
pass Cloudflare Turnstile through a WebView (issue #649). Post-1.0 roadmap item v1.1, see
[`docs/roadmap/post-1.0.md`](../roadmap/post-1.0.md).

## Stack

| Concern       | Choice                                                                                |
| ------------- | ------------------------------------------------------------------------------------- |
| Runtime       | Expo SDK 58, React Native 0.88, Hermes (the SDK 58 default; no `jsEngine` switch)     |
| Navigation    | expo-router (file routes under `apps/mobile/app/`)                                    |
| Styling       | NativeWind 4 (Tailwind 3), theme generated from `@athlya/shared/tokens`               |
| Secrets       | `expo-secure-store` (iOS Keychain `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; Android Keystore) |
| Biometrics    | `expo-local-authentication`                                                           |
| Offline queue | `react-native-mmkv` 4 (AES-256, per-install key in secure storage)                    |
| Connectivity  | `@react-native-community/netinfo`                                                     |
| Charts        | `react-native-svg` 15.16 (SDK 58 pin); maths in `@athlya/shared/charts`               |
| QR code       | `qrcode-generator` 2 (pure-JS encoder) drawn with `react-native-svg` 15.16            |
| Bot check     | `react-native-webview` 14.0.1 (the SDK 58 pin) hosting the API's Turnstile page       |
| Builds        | EAS Build / Submit — operator steps in [`mobile-eas.md`](../runbooks/mobile-eas.md)   |

## Checklist (`tasks.md` § 11)

- [x] 11.1 Expo scaffold + NativeWind + shared tokens + accessible primitives
- [x] 11.2 Refresh token in `expo-secure-store`, access token in memory
- [x] 11.3 Biometric unlock of the stored refresh token
- [x] 11.4 API client: bearer token, refresh-on-401 + single retry, `Idempotency-Key`
- [x] 11.5 `MutationQueue` persisted in MMKV, with a DLQ
- [x] 11.6 `drainMutationQueue` (design.md Algorithm 4)
- [x] 11.7 NetInfo auto-drain + sync progress
- [x] 11.8 Booking screen with optimistic update (+ "My reservations" with cancellation)
- [x] 11.9 QR check-in screen (rotating single-use code, #648)
- [x] 11.10 Workout logging (offline enqueue)
- [x] 11.11 RGPD export / delete screens (in Settings)
- [x] 11.12 Property 5 (FIFO + idempotent drain), fast-check
- [x] 11.13 `MutationQueue` persistence unit tests

## Layout

```
apps/mobile/
├── app/                     expo-router routes (_layout.tsx boots the runtime)
├── components/              UI; components/ui/ holds the accessible primitives
├── features/                screen logic: controllers, view models, the write path (Node-tested)
├── infrastructure/
│   ├── api/client.ts        createApiClient(): send/get/post/put/patch/del
│   ├── auth/                TokenStore, createSessionRefresher, Expo adapters
│   ├── storage/             KeyValueStore port, MMKV adapter, storage key
│   ├── sync/                MutationQueue, drainMutationQueue, SyncController, NetInfo adapter
│   └── runtime.ts           composition root (the only place wiring native modules)
├── theme/preset.ts          Tailwind theme from @athlya/shared/tokens
└── tests/                   vitest (Node): unit/ and properties/
```

Everything under `infrastructure/` except the `expo-*`, `mmkv-store` and `netinfo-connectivity`
adapters and `runtime.ts` is plain TypeScript behind small ports (`KeyValueStore`, `SecureStorage`,
`BiometricAuthenticator`, `ConnectivitySource`), so `pnpm --filter @athlya/mobile test` runs in
Node without a device or simulator.

## Runtime contracts

- **Runtime**: `useRuntime()` (`components/RuntimeProvider.tsx`) returns `{ locale, apiBaseUrl, t,
api, tokenStore, queue, sync, dispose }`.
- **Online calls**: `runtime.api.post<T>(path, body, { idempotencyKey })` and friends throw
  `ApiError` (with the parsed `ProblemDetails`) on non-2xx, `AuthRequiredError` when the session
  cannot be refreshed, `NetworkError` when no response arrived.
- **Offline writes**: `runtime.queue.enqueue({ ownerId, kind, method?, path, payload?,
idempotencyKey? })` returns the `PendingMutation`; then call `runtime.sync.syncNow()` (it never
  rejects). `ownerId` is the signed-in user's id (`await runtime.tokenStore.getUserId()`); the
  drain only sends a user's own mutations, so another account's entries wait for that user. When
  the user is online, call the API directly with a fresh UUID v4 key and, on `NetworkError`,
  enqueue the mutation **with that same `idempotencyKey`** so a write that did reach the server
  is not applied twice. A request cancelled through `signal` rethrows its abort error and must
  not be queued.
- **Sync status**: `runtime.sync.subscribe()` / `getState()` (`useSyncExternalStore`), rendered by
  `<SyncStatusBanner>`; its `pending` / `deadLetters` counts only cover the signed-in user.
  `runtime.queue.deadLetters(userId)` / `discardDeadLetter(id, userId)` back the "rejected changes"
  view and never return or delete another account's entries.
- **Sign-in**: `POST /v1/auth/login` goes out with `{ authenticated: false, headers: {
'cf-turnstile-token': token } }` (see [Bot protection](#bot-protection-turnstile)); then pass
  `{ ...session, userId: session.user.id }` to `runtime.tokenStore.saveSession()`.
  `await setBiometricUnlockEnabled(true)` resolves `true` only when the gate is on: it resolves
  `false`, enabling nothing, when biometrics are unavailable or the prompt is declined, so show the
  setting from that result. `clear()` signs out and invalidates any refresh in flight; `lock()`
  invalidates in-flight refreshes too (a rotated refresh token is kept, the store stays locked).
  Call `runtime.sync.refreshOwner()` after every sign-in and sign-out.
- **Strings**: add keys under `mobile.*` in `packages/shared/src/i18n/{en,fr}.json`.
- **QR check-in (11.9)**: `runtime.api.post<CheckInTokenResponse>('/v1/checkins/token', {})` returns
  `{ token, expiresAt }` (`CheckInTokenResponseSchema`). Render `token` as the QR payload and fetch a
  new one before `expiresAt` (the token lives 120 s and is single-use). Never queue it offline and
  never cache it. The kiosk (staff) posts the scanned token to `POST /v1/checkins`; a member's own
  session gets 403 there.

## Screens

| Route           | What it does                                                                                 | API                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `/login`        | Email + password sign-in, Turnstile check                                                    | `GET /v1/auth/turnstile-challenge` (WebView), `POST /v1/auth/login`                             |
| `/register`     | Account creation with studio slug and consents, Turnstile check                              | `GET /v1/auth/turnstile-challenge` (WebView), `POST /v1/auth/register`                          |
| `/`             | Sync banner, today's program workout (24.4), navigation                                      | `GET /v1/programs/today?date=<local date>`                                                      |
| `/classes`      | Next 14 days of classes, booking with an optimistic seat count (11.8)                        | `GET /v1/classes?from=<ISO>&to=<ISO>` (both required, 90 days at most), `POST /v1/reservations` |
| `/reservations` | Upcoming reservations, cancellation until 2 h before the class                               | `GET /v1/reservations/me`, `DELETE /v1/reservations/{id}`                                       |
| `/workout`      | Workout log: exercises, sets, reps, weight, duration, notes (11.10)                          | `POST /v1/sessions`                                                                             |
| `/progression`  | Progression graphs over 30/90/365 days: volume, estimated 1RM, weekly frequency (22.2)       | `GET /v1/me/progression?window=30\|90\|365` (ETag / `If-None-Match`)                            |
| `/checkin`      | Rotating single-use QR code staff scan at the front desk (11.9)                              | `POST /v1/checkins/token` (body `{}`)                                                           |
| `/settings`     | Biometric unlock, rejected changes (DLQ), RGPD export and account deletion (11.11), sign-out | `POST /v1/members/me/export`, `DELETE /v1/auth/me`, `POST /v1/auth/logout`                      |

Screens behind the sign-in gate (`<SignedIn>`, `components/AppSession.tsx`) redirect to `/login` when
no session is stored. Every response body the app reads (sessions, class and reservation lists,
booking result, export job, today's program, progression) is validated with the `@athlya/shared`
Zod schemas; the bodies of cancellation, workout and deletion responses are not read.

**Write path** (`features/writes.ts`, `submitWrite`): online, the request goes out with a fresh UUID
v4 `Idempotency-Key`; on `NetworkError` it is queued with that same key and a drain starts. It is
queued straight away while the device is offline, or while older writes of the same user are still
queued, so a direct call never overtakes them (the drain is FIFO). Writes of one user are also
serialized: a newer write only goes out once every older one was acknowledged or queued. A
cancelled request is never queued. Queue kinds: `bookClass`, `cancelReservation`, `logSession`; the
Settings screen labels rejected ones by kind. Sign-in, sign-out, export and account deletion call the
API directly and are online only. Signing in starts a drain for changes queued earlier.

**Optimistic booking** (`ClassesController.book`): the seat count drops at once, the decrement is
undone on an API error (never on a full class, which only joins the waitlist), and the list is fetched
again afterwards. A queued booking keeps its decrement (re-applied on every reload) and shows as
waiting to sync; once it leaves the queue (delivered or dead-lettered) the list is fetched again.
Queued cancellations are reconciled the same way on "My reservations".

**Progression graphs** (`features/progression/`, task 22.2): `ProgressionController` keeps the last
body and `ETag` of each window in memory, revalidates it with `If-None-Match` and reuses it on `304`
(`RequestOptions.headers` carries the header). A newer load, or leaving the screen (`cancel()`),
aborts the one in flight; the screen is keyed by user id, so the cache never crosses accounts. The charts (`components/SeriesChart.tsx`, `react-native-svg`) use the same scale and
path maths as the web ones (`@athlya/shared/charts`). Screen readers cannot explore SVG marks, so each
chart is one `image` element whose label holds its key numbers: days trained, date range, latest,
highest and lowest value, or weeks and sessions for the frequency chart. A chart with nothing to draw
shows a text empty state instead.

**QR check-in** (`features/checkin/checkin-token.ts`, `CheckinTokenController`): the screen fetches a
token when it gains focus with the app in the foreground and stops (timers cleared, request in
flight aborted) when it loses focus or the app leaves the foreground (`AppState`). The next token is
fetched 15 s before `expiresAt`, and a countdown shows the seconds left. The request is never queued:
offline, a token that is still valid stays on screen (the kiosk is online and can scan it) and, once
it expires, a notice says a connection is needed; the code is fetched again as soon as the device
is back online. A network failure retries after 10 s, a 429 after 60 s (`checkin_limit_reached`, the
5-per-hour bound of #338, has its own message); an expired session shows the sign-in action and stops
the refresh. The QR is dark on a light quiet zone in both themes and has an accessibility label with
the seconds left. Screen brightness is not raised (it needs `expo-brightness`, a native module not in
the app yet). `react-native-svg` is a native module, so a new development or EAS build is needed.

**Account deletion**: once the API accepted it, the device removes the user's queued and rejected
changes, then clears the session (or locks it in memory if the secure storage fails) and leaves the
signed-in area whatever happens locally.

**Known gaps**:

- QR check-in needs its API: `POST /v1/checkins/token` (and the kiosk's `POST /v1/checkins`) is
  routed on the reservations Worker since #654, once migration 0045 is applied and that Worker is
  redeployed with the JWT signing secrets. Until then the screen shows the load error.
  `POST /v1/sessions` is routed on the reservations Worker
  since #652, but only once the operator has applied migration 0044 and then, from `packages/api`,
  run `wrangler deploy --config wrangler.reservations.toml --env staging` followed by
  `wrangler deploy --config wrangler.reservations.toml --env production`. Until those named-env
  deploys run, the route stays unrouted in that environment: workouts logged online fail and
  queued ones end up in "rejected changes".

## Bot protection (Turnstile)

`POST /v1/auth/login` and `POST /v1/auth/register` sit behind the API's `turnstile()` middleware
(Requirement 26): a request without a valid `cf-turnstile-token` header gets
`403 bot_challenge_failed`. The app solves the **real** Turnstile widget in a WebView, as
Cloudflare documents for mobile apps
([mobile implementation](https://developers.cloudflare.com/turnstile/get-started/mobile-implementation)).
Server-side verification is the same siteverify call as for the web: there is no mobile-only route
and no relaxed check.

Flow:

1. `<TurnstileChallenge>` (`components/TurnstileChallenge.tsx`) loads
   `GET {EXPO_PUBLIC_API_URL}/v1/auth/turnstile-challenge?lang=<fr|en>&theme=<light|dark>`.
2. The auth Worker answers a small HTML page (`packages/api/src/routes/turnstile-challenge.ts`)
   that renders the widget with the public site key `TURNSTILE_SITE_KEY`. Its CSP is
   `default-src 'none'` plus a per-response nonce for its own inline script and style; scripts,
   frames and connections are allowed to `https://challenges.cloudflare.com` only. The page holds no
   secret.
3. The page posts the widget events to the app through `window.ReactNativeWebView.postMessage`:
   `ready`, `token`, `expired`, `timeout`, `error`. The app accepts them only from the API's
   challenge page and validates their shape (`features/auth/turnstile.ts`).
4. The submit button stays disabled until a token is held. `signIn` / `register` send it as
   `cf-turnstile-token`, exactly like the web client.
5. Tokens are single-use: after every attempt the API saw (success or error), the screen remounts
   the WebView for a fresh challenge. A form rejected locally (invalid field) keeps its token.

States shown under the widget (strings `mobile.auth.turnstile.*`, FR/EN, announced to screen
readers through `<Notice>`): in progress, passed, expired (Turnstile renews the token by itself,
`refresh-expired: auto`), failed (widget error, timeout, page not loaded, offline) with a "Retry
the security check" button that reloads the challenge. The widget does not retry on its own
(`retry: never`), so a failure is always visible. While no token is held, the submit button's
accessibility hint says the check must be completed first. A `403 bot_challenge_failed` from the
API maps to `mobile.auth.errors.botCheck` ("complete the check again, then retry").

The WebView only navigates to the challenge page, `challenges.cloudflare.com` frames and
`about:blank`; other links (Turnstile's privacy and help links) open in the system browser when they
are `https` and are dropped otherwise. File access, multiple windows and mixed content are off.

In `ENVIRONMENT=dev`, a missing `TURNSTILE_SITE_KEY` falls back to Cloudflare's always-pass test key
`1x00000000000000000000AA`, and a missing `TURNSTILE_SECRET` makes the middleware skip siteverify,
so a local `wrangler dev` works out of the box. In every other environment a missing or malformed
site key makes the page answer `500 configuration_error` and the app shows the failed state.

### Operator steps

1. **Allowed hostnames** — in the Cloudflare dashboard (Turnstile → the widget whose site key the
   production web app uses → Settings → Hostname management), add `api.athlya.app`. The widget
   checks the hostname of the page that renders it, which is the API host, not `app.athlya.app`;
   without it the widget fails with error `110200`. If staging uses a real (non-test) widget, add
   `staging.api.athlya.app` to that widget too.
2. **Site key on the auth Worker** — the page reads the binding `TURNSTILE_SITE_KEY`. The value is
   public but is stored as a Wrangler secret so that `wrangler deploy` (which replaces dashboard
   variables with the `[vars]` of the config) and canary uploads keep it:

   ```bash
   cd packages/api
   pnpm exec wrangler secret put TURNSTILE_SITE_KEY --config wrangler.auth.toml --env staging
   pnpm exec wrangler secret put TURNSTILE_SITE_KEY --config wrangler.auth.toml --env production
   ```

   Use the same site key as the web app of that environment (GitHub environment variable
   `TURNSTILE_SITE_KEY`): it must pair with the `TURNSTILE_SECRET` already set on the auth Worker.
   Staging pairs Cloudflare's test keys (site key `1x00000000000000000000AA`, secret
   `1x0000000000000000000000000000000AA`); check that both halves on staging are test keys, or
   both real ones. A secret takes effect without a redeploy.

3. **Check** — `node scripts/verify-secrets.mjs --env staging` (then `--env production`) fails
   while `TURNSTILE_SITE_KEY` is missing on the auth Worker: it is a required secret there, and the
   deploy workflows run this check first, so set the key **before** the next API deploy. Then open
   `https://staging.api.athlya.app/v1/auth/turnstile-challenge` in a browser: the widget must
   render and pass, and the response must carry the `Content-Security-Policy` header.
4. **Release build** — sign in and register from a `preview` build against staging, then from a
   `production` build.

### Device attestation (server side only for now)

The API can verify Play Integrity (Android) and DeviceCheck (iOS) tokens as an **extra** signal
after Turnstile, sent as `x-device-attestation-platform` / `x-device-attestation-token` (#659). It is
off by default (`DEVICE_ATTESTATION_MODE` unset), and a request without these headers is never
affected, so the current app keeps working unchanged. The app does not send them yet: obtaining the
tokens needs a native module and is tracked in #686. Contract, modes and operator steps:
[`docs/runbooks/device-attestation.md`](../runbooks/device-attestation.md).

## Drain semantics (Algorithm 4)

FIFO; `2xx`/`409` remove; other `4xx` go to the DLQ with the problem `code`; `5xx`, network errors,
`408` and `429` retry with `min(2^attempt × 1 s, 30 s) + jitter` up to 5 attempts, after which the
mutation stays at the head of the queue and the drain stops so nothing overtakes it. The drain also
stops when the device goes offline (checked before every mutation and every retry), and when no
user is signed in or the session cannot be refreshed (`auth-required`, the queue is left untouched
until the user signs in again). Before every attempt it re-checks that the mutation is still queued
and that its owner is still the signed-in user, so a sign-out, an account deletion or another
sign-in stops it before anything is sent under the wrong session.

## Brand

BR.4, A-mi mascot (ink `#0A0A0A` / volt `#D7FF3A`, see [`docs/brand/README.md`](../brand/README.md)):

- App icon and Android adaptive-icon foreground: `assets/brand/png/athlya-appicon-1024.png`,
  referenced from `app.json` (the mascot sits inside the adaptive-icon safe zone).
- Splash: ink background with the volt mascot, `apps/mobile/assets/splash-mascot.png` (a crop of the
  1024 px app icon, so its ink matches the splash background exactly). Regenerate it from the icon
  whenever the brand PNGs change.

## Local development

```bash
pnpm --filter @athlya/shared build          # Metro resolves @athlya/shared through dist/
cd apps/mobile
EXPO_PUBLIC_API_URL=http://10.0.2.2:8787 pnpm android   # or: pnpm ios (macOS)
```

Native modules (MMKV, SecureStore, LocalAuthentication, NetInfo) need a development build
(`expo run:*` or EAS); Expo Go is not supported. `EXPO_PUBLIC_API_URL` is mandatory (no fallback:
the app refuses to boot and EAS builds fail without it) and must be HTTPS except for loopback
hosts. EAS profiles pin it in `eas.json` (`preview` → `https://staging.api.athlya.app`).

## CI

`lint`, `typecheck` and `test` run in the required `Lint, typecheck, and tests` job like every
workspace. The package has no `build` script, so `pnpm build:ci` never starts a native build.

## Compliance

Expo Push SCC: [`docs/compliance/expo-push-transfers.md`](../compliance/expo-push-transfers.md)
(#86).
