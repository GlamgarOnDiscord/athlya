# Runbook — Cloudflare Access on `/admin/*` (issue #273)

## Context

`/admin/*` routes (DLQ drain, JWT rotation) are protected by `jwtAuth()` +
`requireRole('admin')`. This runbook adds a Cloudflare Access policy as a
defense-in-depth layer so a stolen admin JWT alone is not sufficient to reach
these endpoints from the public internet.

The `cfAccessGuard()` middleware in `packages/api/src/middleware/cf-access-guard.ts`
enforces a valid `CF-Access-JWT-Assertion` header on every `/admin/*` request
when `CF_ACCESS_AUD` and `CF_ACCESS_CERTS_URL` are configured. The guard is a
no-op when either binding is absent (dev / unconfigured).

## Setup

### 1. Create a CF Access Application

1. Go to **Cloudflare Zero Trust → Access → Applications → Add an Application**.
2. Select **Self-hosted**.
3. Name: `Athlya Admin API (production)` (or `staging`).
4. Application domain: `api.athlya.app/admin/*` (or `staging.api.athlya.app/admin/*`).
5. Policy: **Email domain** `athlya.app` + **MFA required**.
6. Note the **Application AUD** (a UUID) shown after saving.

### 2. Get the team JWKS URL

Your team domain is shown in **Zero Trust → Settings → Custom Pages**. The
JWKS URL follows the pattern:

```
https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
```

### 3. Configure Worker secrets

```bash
# Production
wrangler secret put CF_ACCESS_AUD --env production
# paste the AUD UUID

wrangler secret put CF_ACCESS_CERTS_URL --env production
# paste https://<team>.cloudflareaccess.com/cdn-cgi/access/certs

# Staging (optional but recommended)
wrangler secret put CF_ACCESS_AUD --env staging
wrangler secret put CF_ACCESS_CERTS_URL --env staging
```

### 4. Verify

After the next deploy, a request to `/admin/jwt/state` without a CF Access
session should return `403 cf_access_required`. Accessing through the CF Access
portal (after MFA) should return normally.

## How it works

1. CF Access intercepts the request at the Cloudflare edge.
2. If the user is authenticated (valid CF Access session cookie), CF injects
   `CF-Access-JWT-Assertion: <signed-jwt>` before forwarding to the Worker.
3. The Worker's `cfAccessGuard()` middleware verifies the JWT signature and
   audience against the CF Access JWKS endpoint.
4. If valid, the request continues to `jwtAuth()` + `requireRole('admin')`.

## Bypassing in on-call scripts

On-call scripts that call `/admin/*` directly (not through a browser) must
use a **CF Access Service Token** instead of a browser session. See
[CF Access Service Tokens](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/)
for setup. Pass the token via the `CF-Access-Client-Id` and
`CF-Access-Client-Secret` headers.

## Dev environment

`CF_ACCESS_AUD` and `CF_ACCESS_CERTS_URL` are intentionally absent from
`.dev.vars.example` — the guard is a no-op in dev so local development
does not require CF Access. Do not set these values in dev.
