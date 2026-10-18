# Mobile — Epic 10 (`apps/mobile`)

**Status**: foundation delivered (issue #638, 9/13 tasks). The screens (11.8 to 11.11) follow in a
separate PR. Post-1.0 roadmap item v1.1, see [`docs/roadmap/post-1.0.md`](../roadmap/post-1.0.md).

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
| Builds        | EAS Build / Submit — operator steps in [`mobile-eas.md`](../runbooks/mobile-eas.md)   |

## Checklist (`tasks.md` § 11)

- [x] 11.1 Expo scaffold + NativeWind + shared tokens + accessible primitives
- [x] 11.2 Refresh token in `expo-secure-store`, access token in memory
- [x] 11.3 Biometric unlock of the stored refresh token
- [x] 11.4 API client: bearer token, refresh-on-401 + single retry, `Idempotency-Key`
- [x] 11.5 `MutationQueue` persisted in MMKV, with a DLQ
- [x] 11.6 `drainMutationQueue` (design.md Algorithm 4)
- [x] 11.7 NetInfo auto-drain + sync progress
- [ ] 11.8 Booking screen with optimistic update
- [ ] 11.9 QR check-in screen
- [ ] 11.10 Workout logging (offline enqueue)
- [ ] 11.11 RGPD export / delete screens
- [x] 11.12 Property 5 (FIFO + idempotent drain), fast-check
- [x] 11.13 `MutationQueue` persistence unit tests

## Layout

```
apps/mobile/
├── app/                     expo-router routes (_layout.tsx boots the runtime)
├── components/              UI; components/ui/ holds the accessible primitives
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

## Contracts for the screens PR

- **Runtime**: `useRuntime()` (`components/RuntimeProvider.tsx`) returns `{ locale, t, api,
tokenStore, queue, sync, dispose }`.
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
- **Sign-in**: after `POST /v1/auth/login` (`{ authenticated: false }`), pass
  `{ ...session, userId: session.user.id }` to `runtime.tokenStore.saveSession()`.
  `await setBiometricUnlockEnabled(true)` resolves `true` only when the gate is on: it resolves
  `false`, enabling nothing, when biometrics are unavailable or the prompt is declined, so show the
  setting from that result. `clear()` signs out and invalidates any refresh in flight; `lock()`
  invalidates in-flight refreshes too (a rotated refresh token is kept, the store stays locked).
  Call `runtime.sync.refreshOwner()` after every sign-in and sign-out.
- **Strings**: add keys under `mobile.*` in `packages/shared/src/i18n/{en,fr}.json`.

## Drain semantics (Algorithm 4)

FIFO; `2xx`/`409` remove; other `4xx` go to the DLQ with the problem `code`; `5xx`, network errors,
`408` and `429` retry with `min(2^attempt × 1 s, 30 s) + jitter` up to 5 attempts, after which the
mutation stays at the head of the queue and the drain stops so nothing overtakes it. The drain also
stops when the device goes offline (checked before every mutation and every retry), and when no
user is signed in or the session cannot be refreshed (`auth-required`, the queue is left untouched
until the user signs in again).

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
