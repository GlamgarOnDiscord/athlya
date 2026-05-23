# Runbook — Preview environments per PR (CN.7.2)

Each pull request automatically gets an isolated API preview:

- **Neon branch** — a DB fork created from the project primary branch. Schema + seed data are copied; writes are fully isolated from staging/production.
- **Cloudflare Worker** — the `athlya-api-preview` Worker is deployed with the PR's `DB_URL` secret pointing at the Neon branch. All other infrastructure (Redis, queues, R2) is shared with staging.

The Neon branch is deleted when the PR closes.

---

## One-time setup

### 1. GitHub secrets

In **Settings → Secrets → Actions**, add:

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | CF API token with **Workers:Edit** scope |
| `CLOUDFLARE_ACCOUNT_ID` | CF account ID (visible in the Cloudflare dashboard URL) |
| `NEON_API_KEY` | Neon project API key (Project settings → API keys) |
| `PREVIEW_REDIS_URL` | Upstash Redis URL — staging instance |
| `PREVIEW_REDIS_TOKEN` | Upstash Redis token — staging instance |
| `PREVIEW_JWT_JWKS_URL` | JWKS endpoint for preview JWT verification |
| `PREVIEW_TURNSTILE_SECRET` | Cloudflare Turnstile secret (staging key is fine) |

### 2. GitHub variables

In **Settings → Variables → Actions**, add:

| Variable | Example |
|----------|---------|
| `NEON_PROJECT_ID` | `proud-dream-12345678` (Neon dashboard → Project settings) |
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
wrangler secret put DB_URL=<neon_branch_url> --env preview
wrangler secret put REDIS_* / JWT_JWKS_URL / TURNSTILE_SECRET --env preview
       │
       ▼
wrangler versions upload --env preview --var VERSION=pr{N}-{SHA}
       │
       ▼
Post/update PR comment with preview URL + branch name
       │
PR closed (merged or abandoned)
       │
       ▼
Delete Neon branch "preview-pr-{N}"
```

---

## Known limitations

**Concurrent PR deployments race on the `DB_URL` secret.**
The `athlya-api-preview` Worker is a single shared environment. If two PRs deploy simultaneously, the last `wrangler secret put DB_URL` wins — both previews will point at the same Neon branch until the slower job completes.

Mitigation for small teams: the `concurrency` group in the workflow serialises deployments *within* a single PR. Across PRs there is no lock. If the team works with many concurrent PRs, consider upgrading to per-PR Worker names (requires dynamic wrangler.toml generation).

**Preview uses staging Redis / queues / R2.**
Events, exports and avatars written during preview testing land in the staging stores. This is intentional to keep setup simple. Clean up manually if needed:

```bash
# List preview exports in R2
wrangler r2 object list athlya-exports-preview --env preview
```

---

## Manual teardown

If the workflow fails to clean up a Neon branch:

```bash
curl -sf "https://api.neon.tech/v1/projects/${NEON_PROJECT_ID}/branches" \
  -H "Authorization: Bearer ${NEON_API_KEY}" | \
  jq '.branches[] | select(.name | startswith("preview-pr-")) | {id, name}'
```

Then delete by ID:

```bash
curl -sf -X DELETE \
  "https://api.neon.tech/v1/projects/${NEON_PROJECT_ID}/branches/${BRANCH_ID}" \
  -H "Authorization: Bearer ${NEON_API_KEY}"
```
