# Runbook — Secret rotation

Rotation procedure for every secret type used by the Athlya API workers.
Run on the schedule below or immediately on suspected compromise.

| Secret group              | Recommended cycle                  | Emergency                          |
| ------------------------- | ---------------------------------- | ---------------------------------- |
| JWT signing keys          | 90 days                            | Immediate on any compromise signal |
| DB_URL (app)              | 180 days                           | Immediate                          |
| CRON_DB_URL               | 180 days                           | Immediate                          |
| MIGRATION_DB_URL          | After each major migration window  | Immediate                          |
| Redis (REDIS_URL/TOKEN)   | 180 days                           | Immediate                          |
| Stripe keys               | Per Stripe recommendation (annual) | Immediate                          |
| SENTRY_DSN                | Annual                             | Immediate                          |
| TURNSTILE_SECRET          | Annual                             | Immediate                          |
| MISTRAL_API_KEY           | Annual                             | Immediate                          |
| CALENDAR_FEED_SIGNING_KEY | Only on compromise (revokes feeds) | Immediate                          |

---

## Pre-rotation checklist (all types)

```bash
# 1. Confirm current state — every required secret present
node scripts/verify-secrets.mjs --env staging
node scripts/verify-secrets.mjs --env production

# 2. Have the rollback plan ready (previous value or previous deploy version)
# 3. Schedule during low-traffic window for production (00:00–06:00 CET)
```

---

## JWT signing keys

See the dedicated runbook: [`docs/runbooks/rotate-jwt.md`](./rotate-jwt.md).

Summary: use `POST /v1/admin/jwt/rotate-prepare` to generate the new keypair,
set the new secrets with a 24h grace window, then remove the old key.

---

## DB_URL (athlya_app role)

`DB_URL` is the Neon connection string used by all four workers at runtime.
The `athlya_app` role is NOBYPASSRLS — a leaked URL gives read/write access
scoped to the connected tenant only (RLS enforced).

```bash
# 1. Generate a new password for the athlya_app role on Neon Console
#    (Project → Roles → athlya_app → Reset password)
#    Copy the new connection string.

# 2. Stage the new secret without cutting over yet — set it on one worker first:
pnpm --filter @athlya/api exec wrangler secret put DB_URL --env staging
# Paste the new connection string when prompted.

# 3. Run a staging smoke to verify connectivity:
node scripts/verify-secrets.mjs --env staging
node scripts/smoke-routes.mjs --base-url "${STAGING_API_URL}"

# 4. Roll out to production (all four workers):
for cfg in "" "-c wrangler.auth.toml" "-c wrangler.reservations.toml" "-c wrangler.billing.toml"; do
  pnpm --filter @athlya/api exec wrangler secret put DB_URL --env production $cfg
done

# 5. Verify:
node scripts/verify-secrets.mjs --env production

# 6. Revoke the old password on Neon (delete the old role credential).
```

---

## CRON_DB_URL (athlya_cron role — BYPASSRLS, main worker only)

`CRON_DB_URL` is set only on the main worker. The `athlya_cron` role has
BYPASSRLS — a compromise means cross-tenant read/write on audit_log and
user tables. Treat this with the same urgency as a private key leak.

```bash
# 1. Reset the athlya_cron password on Neon Console.
# 2. Update main worker only:
pnpm --filter @athlya/api exec wrangler secret put CRON_DB_URL --env staging
pnpm --filter @athlya/api exec wrangler secret put CRON_DB_URL --env production

# 3. Verify the RGPD cron ran without error on the next minute tick
#    (check Cloudflare Tail Worker logs or Axiom for cron execution).

# 4. Revoke the old Neon credential.
```

---

## MIGRATION_DB_URL (neondb_owner — CI only)

`MIGRATION_DB_URL_STAGING` and `MIGRATION_DB_URL_PRODUCTION` are GitHub
Actions secrets used only during `staging-deploy` and `production-deploy`
phases. They use the Neon owner role (BYPASSRLS + DDL). They must NOT be
set in any worker's runtime environment.

```bash
# 1. Reset the neondb_owner password on Neon Console for the target branch.
# 2. Update the GitHub Actions secret:
gh secret set MIGRATION_DB_URL_STAGING  --repo GlamgarOnDiscord/athlya
gh secret set MIGRATION_DB_URL_PRODUCTION --repo GlamgarOnDiscord/athlya

# 3. Trigger a staging-deploy dry run to confirm migrations still apply:
gh workflow run deploy-production.yml -f phase=staging-deploy

# 4. Revoke the old credential on Neon.
```

---

## Redis (REDIS_URL + REDIS_TOKEN)

Upstash Redis is used for rate limiting, idempotency keys, and JWKS cache.
A leaked token gives read/write access to all rate limit counters and
idempotency state (not business data, but enables rate limit bypass).

```bash
# 1. On Upstash Console, rotate the REST token for the target database.
#    Copy the new REDIS_URL (endpoint) and REDIS_TOKEN (bearer token).

# 2. Update all four workers (main carries both; sub-workers only need them
#    if they perform rate limiting — check wrangler.*.toml bindings):
for cfg in "" "-c wrangler.auth.toml" "-c wrangler.reservations.toml" "-c wrangler.billing.toml"; do
  pnpm --filter @athlya/api exec wrangler secret put REDIS_URL --env production $cfg
  pnpm --filter @athlya/api exec wrangler secret put REDIS_TOKEN --env production $cfg
done

# 3. Verify:
node scripts/verify-secrets.mjs --env production

# 4. Revoke the old token on Upstash.
#
# Note: active rate limit windows will be lost on the new token — a brief
# burst of previously-throttled requests may succeed. Acceptable trade-off.
```

---

## Stripe keys (STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET)

A leaked `STRIPE_SECRET_KEY` allows arbitrary Stripe API calls in the
connected account's name. Treat as critical.

```bash
# 1. On Stripe Dashboard → Developers → API keys, roll the restricted key.
# 2. On Stripe Dashboard → Developers → Webhooks, regenerate the signing secret
#    for the endpoint (staging and production separately).

# 3. Update main and billing workers:
for cfg in "" "-c wrangler.billing.toml"; do
  pnpm --filter @athlya/api exec wrangler secret put STRIPE_SECRET_KEY --env production $cfg
  pnpm --filter @athlya/api exec wrangler secret put STRIPE_WEBHOOK_SECRET --env production $cfg
done

# 4. Send a test webhook from Stripe Dashboard to confirm the new secret validates.
# 5. Revoke the old Stripe key.
```

---

## SENTRY_DSN

Read-only ingest key. A leak allows third-party event injection into the
Sentry project. Low severity.

```bash
# 1. On Sentry → Settings → Client Keys, revoke and regenerate the DSN.
# 2. Update all workers:
for cfg in "" "-c wrangler.auth.toml" "-c wrangler.reservations.toml" "-c wrangler.billing.toml"; do
  pnpm --filter @athlya/api exec wrangler secret put SENTRY_DSN --env production $cfg
done
# 3. Deploy a canary to confirm errors still reach Sentry.
```

---

## TURNSTILE_SECRET

Used to verify Cloudflare Turnstile tokens on public endpoints (register,
login, password-reset). A leaked secret allows bypassing CAPTCHA.

```bash
# 1. On Cloudflare Dashboard → Turnstile → your site → Rotate secret key.
# 2. Update main and auth workers:
for cfg in "" "-c wrangler.auth.toml"; do
  pnpm --filter @athlya/api exec wrangler secret put TURNSTILE_SECRET --env production $cfg
done
# 3. Run a smoke test through the register flow to confirm Turnstile passes.
```

---

## MISTRAL_API_KEY

Mistral AI key of the AI coach (Epic 21, `ai-coach` flag). Read by the gateway and the
reservations Worker, which both serve `/v1/coach`. Optional: `verify-secrets.mjs` only warns
when it is missing, and the coach then answers 503 `coach_not_configured` while the flag is on.
A leaked key allows model calls billed to the Athlya account, nothing more: no member data
is reachable with it.

```bash
# 1. Mistral console → API keys → create a new key (workspace "athlya-<env>").
# 2. Set it on both Workers of each env that runs the coach (prompted value, never on
#    the command line). Use the key of the matching workspace for each env:
for env in staging production; do
  for cfg in "" "-c wrangler.reservations.toml"; do
    pnpm --filter @athlya/api exec wrangler secret put MISTRAL_API_KEY --env $env $cfg
  done
done
# 3. Ask the coach once per env from a staff account in the flag allow-list.
# 4. Revoke the old keys in the Mistral console.
```

To switch the coach off without touching the key, set the flag to `false` in
`FEATURE_FLAGS_JSON` ([`feature-flags.md`](../operations/feature-flags.md)).

---

## CALENDAR_FEED_SIGNING_KEY

HMAC key signing the members' iCalendar subscription URLs (`/v1/calendar/*`, issue #719,
[`calendar-feed.md`](../architecture/calendar-feed.md)). Set on the gateway only (`wrangler.toml`).
Optional: `verify-secrets.mjs` only warns when it is missing, and both calendar routes then
answer 503 `calendar_feed_not_configured`. A leaked key lets anyone forge a feed URL for any
member whose id and studio id they know, which exposes that member's class titles and times.

**Rotating it revokes every feed at once**: each subscribed calendar stops refreshing (404) until
the member copies the new URL from `/me`. Do not rotate it on a schedule, only on a suspected leak.
To revoke one member's feed, bump their `credentials_version` instead (logout from all devices,
password reset), which leaves the other feeds alone.

```bash
# 1. Generate a new key (>= 32 chars) and set it on the gateway of each env
#    (prompted value, never on the command line):
openssl rand -base64 48
for env in staging production; do
  pnpm --filter @athlya/api exec wrangler secret put CALENDAR_FEED_SIGNING_KEY --env $env
done
# 2. From a member account: GET /v1/calendar/feed-url, then fetch the returned httpsUrl
#    (200 text/calendar); an URL issued before the rotation now answers 404.
```

---

## After any rotation

```bash
# Confirm all secrets present and pipeline clean:
node scripts/verify-secrets.mjs --env production

# Trigger a staging deploy to exercise the full pipeline:
gh workflow run deploy-production.yml -f phase=staging-deploy

# Update the rotation log in the ops channel with: date, secret type, operator.
```
