# Runbook — Preview environments per PR (CN.7.2)

Each pull request automatically gets an isolated API preview (issues #237, #419):

- **Neon branch** — a DB fork created from the project primary branch. Schema + seed data are copied; writes are fully isolated from staging/production. Migrations are applied automatically after the branch is created.
- **Cloudflare Worker** — `athlya-api-pr-<N>` with secrets scoped to that Worker (including per-PR `DB_URL`). Redis is shared with the dedicated preview database.
- **Queues** — per-PR `athlya-events-preview-pr-<N>*` queues, provisioned on PR open/synchronize and deleted on PR close. Concurrent PRs never share a queue.
- **R2** — shared preview buckets (`athlya-avatars-preview`, `athlya-exports-preview`).

The Neon branch, Worker, and queue set are deleted when the PR closes.

---

## One-time setup

### 1. GitHub secrets

In **Settings → Secrets → Actions**, add:

| Secret                        | Description                                                      |
| ----------------------------- | ---------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`        | CF API token with **Workers:Edit** scope                         |
| `CLOUDFLARE_ACCOUNT_ID`       | CF account ID (visible in the Cloudflare dashboard URL)          |
| `NEON_API_KEY`                | Neon project API key (Project settings → API keys)               |
| `PREVIEW_REDIS_URL`           | Upstash Redis URL — dedicated preview instance                   |
| `PREVIEW_REDIS_TOKEN`         | Upstash Redis token — dedicated preview instance                 |
| `PREVIEW_JWT_JWKS_URL`        | https JWKS endpoint for preview JWT verification (lists the kid) |
| `PREVIEW_JWT_KID`             | Key id of the dedicated preview signing key, `preview-…`         |
| `PREVIEW_JWT_PRIVATE_KEY_PEM` | Multi-line PKCS#8 private key of the preview signing key         |
| `PREVIEW_JWT_PUBLIC_KEY_PEM`  | Multi-line SPKI public key of the same pair                      |
| `PREVIEW_JWKS_JSON`           | Public JWKS the preview serves at `/.well-known/jwks.json`       |
| `PREVIEW_TURNSTILE_SECRET`    | Cloudflare Turnstile secret (staging key is fine)                |

#### Preview JWT signing key

The JWT key material is required, as on staging: without `JWT_KID` the Worker has no
auth/idempotency wiring and rejects every request. It must be a **dedicated preview pair**,
never the staging or production one: preview Workers run PR code, so their private key must not
sign tokens any other environment accepts.

Generate it with the same flow that writes `scripts/dev-secrets/` (real multi-line PEM files and
a JWKS), into a directory of its own so your local dev keys are kept. Do **not** copy the escaped
`.dev.vars` lines the script prints: their literal `\n` sequences break key import.

```sh
KID="preview-$(date +%Y%m%d)"
OUT="$(mktemp -d)"
node scripts/generate-jwt-keypair.mjs --out "$OUT" --kid "$KID"

gh secret set PREVIEW_JWT_KID --body "$KID"
gh secret set PREVIEW_JWT_PRIVATE_KEY_PEM < "$OUT/jwt-private.pem"
gh secret set PREVIEW_JWT_PUBLIC_KEY_PEM < "$OUT/jwt-public.pem"
gh secret set PREVIEW_JWKS_JSON < "$OUT/jwks.json"
rm -rf "$OUT"
```

`PREVIEW_JWT_KID` is the `--kid` value; it is also `keys[0].kid` in `jwks.json`. Publish that
JWKS at `PREVIEW_JWT_JWKS_URL`. Before creating any resource, the deploy job fails when a secret
is missing, and `scripts/validate-preview-jwt.mjs` fails it when the URL is not https, the kid
does not start with `preview-`, a PEM is malformed or escaped, the PEMs are not one pair, or
`PREVIEW_JWKS_JSON` does not list the kid with that public key. The document published at
`PREVIEW_JWT_JWKS_URL` is never fetched: make sure it lists `PREVIEW_JWT_KID` yourself, or tokens
the preview mints fail verification.

### 2. GitHub variables

In **Settings → Variables → Actions**, add:

| Variable                       | Example                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| `NEON_PROJECT_ID`              | `proud-dream-12345678` (Neon dashboard → Project settings) |
| `CLOUDFLARE_WORKERS_SUBDOMAIN` | `athlya` (CF dashboard → Workers → your account subdomain) |
| `NEON_DATABASE_NAME`           | optional, defaults to `neondb`                             |
| `NEON_OWNER_ROLE`              | optional, defaults to `neondb_owner`                       |

The Neon parent branch must contain the `athlya_app` role (no `BYPASSRLS`)
with a password: each preview branch inherits it, and the workflow fetches
its connection URI through the Neon v2 `connection_uri` API. The owner role
URI (`NEON_OWNER_ROLE`) is only used for migrations, because outside `dev`
the Worker rejects every `/v1/*` request with a `BYPASSRLS` error when its
role bypasses RLS.

### 3. Provision R2 preview buckets

Run once from a machine with wrangler authenticated:

```bash
pnpm --filter @athlya/api exec wrangler r2 bucket create athlya-avatars-preview --env preview
pnpm --filter @athlya/api exec wrangler r2 bucket create athlya-exports-preview --env preview
```

R2 buckets are shared across all preview PRs (not per-PR) and are not deleted on PR close.

---

## How it works

```
PR opened / commit pushed
       │
       ▼
Create Neon branch "preview-pr-{N}"
       │
       ▼
Run DB migrations on the Neon branch (idempotent — migrate.mjs)
       │
       ▼
Generate wrangler.preview-pr.toml (queue names patched to pr-{N} variants)
       │
       ▼
wrangler secret put * --env preview --name athlya-api-pr-{N}
  (DB_URL = athlya_app URI of the branch; CORS_ORIGIN = the preview URL;
   Redis/JWT/Turnstile = preview secrets)
       │
       ▼
Provision per-PR queues: athlya-events-preview-pr-{N},
  athlya-events-preview-pr-{N}-dlq,
  athlya-events-notifications-preview-pr-{N}, ...,
  athlya-outbox-kick-preview-pr-{N}
       │
       ▼
wrangler deploy --config wrangler.preview-pr.toml
  --env preview --name athlya-api-pr-{N} --var VERSION:pr{N}-<sha7>
       │
       ▼
https://athlya-api-pr-{N}.<subdomain>.workers.dev
  /health must report version pr{N}-<sha7>, otherwise the job fails
       │
       ▼
Post/update PR comment with preview URL, Worker name, Neon branch, queues
       │
PR closed (merged or abandoned)
       │
       ▼
wrangler delete --name athlya-api-pr-{N}
Delete per-PR queues: athlya-events-*-preview-pr-{N}* (6 queues)
  + athlya-outbox-kick-preview-pr-{N}
Delete Neon branch "preview-pr-{N}"
Flush Redis keys "pr-{N}:*"
```

Isolation: each PR owns a dedicated Worker, `DB_URL`, Neon branch and queue
set. **Shared** across previews: the preview Redis database (keys prefixed
`pr-{N}:`) and the preview R2 buckets. The Worker runs with
`ENVIRONMENT=preview`, whose Host guard only accepts
`athlya-api-pr-<N>.<subdomain>.workers.dev`.

---

## Manual teardown

If the workflow fails to clean up:

```bash
# Neon branch
curl -sf "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches" \
  -H "Authorization: Bearer ${NEON_API_KEY}" | \
  jq '.branches[] | select(.name | startswith("preview-pr-")) | {id, name}'

# Worker
pnpm --filter @athlya/api exec wrangler delete --name athlya-api-pr-<N> --force

# Queues (replace N with the PR number)
N=<N>
for Q in \
  "athlya-events-preview-pr-${N}" \
  "athlya-events-preview-pr-${N}-dlq" \
  "athlya-events-notifications-preview-pr-${N}" \
  "athlya-events-notifications-preview-pr-${N}-dlq" \
  "athlya-events-rgpd-preview-pr-${N}" \
  "athlya-events-rgpd-preview-pr-${N}-dlq" \
  "athlya-outbox-kick-preview-pr-${N}"; do
  pnpm --filter @athlya/api exec wrangler queues delete "$Q" || true
done
```
