# Device attestation on mobile sign-in (Play Integrity / DeviceCheck)

Issue #659. An extra, flag-gated signal on `POST /v1/auth/login` and `POST /v1/auth/register`, checked
by `packages/api/src/middleware/device-attestation.ts` after Turnstile. It never replaces Turnstile.

## Modes

`DEVICE_ATTESTATION_MODE` on the Worker that serves `/v1/auth/*` (the auth Worker,
`wrangler.auth.toml`; the gateway mounts the same router):

| Value                           | Behaviour                                                                                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unset, `off`, any unknown value | No check, no outbound call. Default.                                                                                                                                                         |
| `report`                        | Verifies a presented attestation and logs `device attestation verdict`. Never blocks: failed verdicts, missing credentials and Google/Apple outages all let the request through (fail open). |
| `enforce`                       | A presented attestation that fails: `403 device_attestation_failed`. Provider outage: `503 device_attestation_unavailable`. Missing or invalid credentials: `500 configuration_error`.       |

In every mode, a request **without** the attestation headers goes through unchanged: the web client
and app builds that predate the feature send none. `enforce` therefore only rejects attestations that
were presented and failed; requiring attestation from mobile clients is a later decision, to be made
from the `report` data once every supported app build sends it.

## Contract

Headers sent by the app next to `cf-turnstile-token`:

- `x-device-attestation-platform`: `android` or `ios`
- `x-device-attestation-token`: at most 16 384 characters

**Android (Play Integrity, standard request).** The app passes as `requestHash`:

```
base64url_nopad( SHA-256( "athlya-auth-v1:" + action + ":" + cfTurnstileToken ) )
```

with `action` = `login` or `register`. The server decodes the token through Google's
`decodeIntegrityToken` and checks, as reasons in the log:

| Check                                                       | Reason on failure                            |
| ----------------------------------------------------------- | -------------------------------------------- |
| `requestDetails.requestPackageName` = package               | `package_mismatch`                           |
| `requestDetails.requestHash` = expected hash                | `request_hash_mismatch`                      |
| `requestDetails.timestampMillis` at most 5 min old          | `token_stale`                                |
| `requestDetails.timestampMillis` at most 60 s in the future | `timestamp_in_future`                        |
| `appIntegrity.appRecognitionVerdict` = `PLAY_RECOGNIZED`    | `app_not_recognized`, `app_package_mismatch` |
| `deviceIntegrity` contains `MEETS_DEVICE_INTEGRITY`         | `device_integrity`                           |

Replay: Turnstile tokens are single-use and verified by siteverify before this check. An integrity
token replayed on another request carries the hash of a spent Turnstile token, so it fails
`request_hash_mismatch` (or Turnstile itself rejects the spent token).

**iOS (DeviceCheck).** The server validates the `DCDevice` token with Apple's
`validate_device_token`. This proves a genuine Apple device running an app of the team, but a
DeviceCheck token carries no request data: the verdict is logged with `requestBound: false`. App
Attest assertions (request-bound, per-device key and counter storage) are a follow-up.

Tokens and request hashes are never logged. Verdict logs carry `traceId`, `mode`, `action`,
`platform`, `outcome` (`pass` | `fail` | `unavailable` | `unconfigured`), `reasons`, and for Android
`appRecognitionVerdict`, `deviceRecognitionVerdict`, `appLicensingVerdict`.

## Operator steps

Nothing is needed while the mode is unset. To start collecting verdicts on staging:

1. **Google Cloud (Android).** In the Google Cloud project linked to the app in Play Console (Play
   Console → App integrity → Play Integrity API → link a Cloud project), enable the Play Integrity
   API, create a service account with no project role, and download a JSON key. The project
   **number** is also needed by the app (`prepareIntegrityTokenProvider`).
2. **Apple (iOS).** In Apple Developer → Keys, create a key with the DeviceCheck capability. Note the
   key id and the team id, download the `.p8` file.
3. **Secrets on the auth Worker** (from `packages/api`; paste the value at the prompt, never on the
   command line, never in a file in the repo):

   ```bash
   pnpm exec wrangler secret put PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON --config wrangler.auth.toml --env staging
   pnpm exec wrangler secret put APPLE_DEVICECHECK_TEAM_ID         --config wrangler.auth.toml --env staging
   pnpm exec wrangler secret put APPLE_DEVICECHECK_KEY_ID          --config wrangler.auth.toml --env staging
   pnpm exec wrangler secret put APPLE_DEVICECHECK_PRIVATE_KEY     --config wrangler.auth.toml --env staging
   # optional, defaults to production; use development for builds signed with a development profile
   pnpm exec wrangler secret put APPLE_DEVICECHECK_ENVIRONMENT     --config wrangler.auth.toml --env staging
   # optional, defaults to app.athlya.mobile
   pnpm exec wrangler secret put PLAY_INTEGRITY_PACKAGE_NAME       --config wrangler.auth.toml --env staging
   ```

   Repeat with `--env production` when rolling out there.

4. **Turn the signal on** in report mode. It is stored as a secret, like `TURNSTILE_SITE_KEY`, so that
   `wrangler deploy` keeps it:

   ```bash
   pnpm exec wrangler secret put DEVICE_ATTESTATION_MODE --config wrangler.auth.toml --env staging   # value: report
   ```

5. **Check.** Sign in from an app build that sends attestation, then search the Worker logs for
   `device attestation verdict`. `outcome: unconfigured` means a secret is missing or malformed;
   `unavailable` with `upstreamStatus: 403` usually means the API is not enabled or the service
   account is not linked in Play Console.
6. **Roll back.** `wrangler secret delete DEVICE_ATTESTATION_MODE --config wrangler.auth.toml --env
<env>` (or set it to `off`): the check stops at once, no deploy needed.

Do not switch to `enforce` before the `report` data shows a negligible false-positive rate on real
devices.

## Cost and latency

- Each attested request makes one provider call (plus one Google OAuth call per isolate and hour),
  each capped at 3 s. Turnstile runs first, so a client must solve a fresh challenge for every
  call it triggers; that bounds how fast a bot can burn the Play Integrity daily quota (10 000
  calls by default, raised from Play Console).
- When Google or Apple is slow, `report` mode adds up to the timeout to the sign-in, then lets the
  request through.
