# Runbook — Preview environments per PR (CN.7.2)

Each pull request automatically gets an isolated API preview:

- **Neon branch** — a DB fork created from the project primary branch. Schema + seed data are copied; writes are fully isolated from staging/production.
- **Cloudflare Worker** — `athlya-api-pr-<N>` with secrets scoped to that Worker (including per-PR `DB_URL`). Redis, queues and R2 are shared with staging.

The Neon branch and Worker are deleted when the PR closes.

---

## One-time setup

### 1. GitHub secrets

In **Settings → Secrets → Actions**, add:

| Secret                     | Description                                             |
| -------------------------- | ------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`     | CF API token with **Workers:Edit** scope                |
| `CLOUDFLARE_ACCOUNT_ID`    | CF account ID (visible in the Cloudflare dashboard URL) |
| `NEON_API_KEY`             | Neon project API key (Project settings → API keys)      |
| `PREVIEW_REDIS_URL`        | Upstash Redis URL — staging instance                    |
| `PREVIEW_REDIS_TOKEN`      | Upstash Redis token — staging instance                  |
| `PREVIEW_JWT_JWKS_URL`     | JWKS endpoint for preview JWT verification              |
| `PREVIEW_TURNSTILE_SECRET` | Cloudflare Turnstile secret (staging key is fine)       |

### 2. GitHub variables

In **Settings → Variables → Actions**, add:

| Variable                       | Example                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| `NEON_PROJECT_ID`              | `proud-dream-12345678` (Neon dashboard → Project settings) |
| `CLOUDFLARE_WORKERS_SUBDOMAIN` | `athlya` (CF dashboard → Workers → your account subdomain) |

### 3. Provision R2 preview buckets

Run once from a machine with wrangler authenticated:

```bash
pnpm --filter @athlya/api exec wrangler r2 bucket create athlya-avatars-preview --env preview
pnpm --filter @athlya/api exec wrangler r2 bucket create athlya-exports-preview --env preview
```

### 4. Provision Cloudflare queues

If the staging queues (`athlya-events-staging`, `athlya-events-staging-dlq`) do not yet exist:

```bash
pnpm --filter @athlya/api exec wrangler queues create athlya-events-staging
pnpm --filter @athlya/api exec wrangler queues create athlya-events-staging-dlq
```

The preview env reuses these queues.

---

## How it works

```
PR opened / commit pushed
       │
       ▼
Create Neon branch "preview-pr-{N}"
       │
       ▼
wrangler secret put * --env preview --name athlya-api-pr-{N}
  (DB_URL = Neon branch URI; Redis/JWT/Turnstile = staging preview secrets)
       │
       ▼
wrangler versions upload --env preview --name athlya-api-pr-{N}
       │
       ▼
https://athlya-api-pr-{N}.<subdomain>.workers.dev
       │
       ▼
Post/update PR comment with preview URL + branch name
       │
PR closed (merged or abandoned)
       │
       ▼
wrangler delete --name athlya-api-pr-{N}
Delete Neon branch "preview-pr-{N}"
```

Concurrent PRs are safe: each PR owns a dedicated Worker name and `DB_URL` secret namespace.

---

## Known limitations

**Preview uses staging Redis / queues / R2.**
Events, exports and avatars written during preview testing land in the staging stores. This is intentional to keep setup simple. Clean up manually if needed:

```bash
# List preview exports in R2
wrangler r2 object list athlya-exports-preview --env preview
```

**Legacy shared Worker `athlya-api-preview`.**
Older PRs may have deployed to the shared Worker before per-PR isolation. Delete it manually if unused:

```bash
pnpm --filter @athlya/api exec wrangler delete --name athlya-api-preview --force
```

---

## Manual teardown

If the workflow fails to clean up:

```bash
# Neon branch
curl -sf "https://api.neon.tech/v1/projects/${NEON_PROJECT_ID}/branches" \
  -H "Authorization: Bearer ${NEON_API_KEY}" | \
  jq '.branches[] | select(.name | startswith("preview-pr-")) | {id, name}'

# Worker
pnpm --filter @athlya/api exec wrangler delete --name athlya-api-pr-<N> --force
```
