# Runbook — Break-glass infra override

**Use this only during incidents where the Terraform pipeline is blocked
and a manual console change is the fastest recovery path.**

## When to use

- Cloudflare Queue down and needs recreating during an incident
- R2 bucket permissions need immediate correction
- Workers route needs emergency update (mis-routing, DDoS mitigation)
- Terraform state is corrupted and plan fails with wrong assumptions

## Procedure

### 1. Notify the team

Post in `#athlya-ops`:

```
[BREAK-GLASS] Applying manual infra change:
  - Resource: <what>
  - Reason: <why IaC path is blocked>
  - Change: <what you're doing in the console>
  - ETA to sync TF state: <date>
  - Owner: @<your handle>
```

### 2. Make the minimum necessary change in the Cloudflare Console

Document exactly what you changed (resource type, name, setting, old value,
new value). Screenshot the before/after state.

### 3. Import the change into Terraform state

After the incident is resolved, import the console change into Terraform state
so it is no longer drift:

```bash
# Example: import a queue that was created manually
terraform import cloudflare_queue.events_dlq \
  "${TF_VAR_cloudflare_account_id}/<queue_id_from_console>"

# Example: import an R2 bucket
terraform import cloudflare_r2_bucket.avatars \
  "${TF_VAR_cloudflare_account_id}/athlya-avatars-production"
```

Verify the import with `terraform plan` — it should show no changes if the
import is correct.

### 4. Open a PR with the corrected Terraform config

If the break-glass change required a config tweak that wasn't reflected in
`infra/terraform/`, open a PR. The CI `terraform plan` must be green before
merge.

### 5. Close the break-glass record

Post in `#athlya-ops`:

```
[BREAK-GLASS CLOSED] Manual change imported into Terraform state.
  - PR: #<n>
  - State drift: resolved
```

## Neon break-glass

Neon changes (role creation, schema changes outside migrations) must go
through `psql` with `neondb_owner` credentials (from 1Password):

```bash
psql "${MIGRATION_DB_URL_PRODUCTION}" -c "ALTER ROLE athlya_cron NOBYPASSRLS;"
```

Document the SQL run, then add a migration to capture the change permanently.

## Never do in the console

- Add or remove Worker secrets (use `wrangler secret put`)
- Change Worker routes without updating `wrangler.toml`
- Delete queues without a corresponding Terraform `terraform destroy -target`
- Create Neon roles without updating `packages/db/migrations/`
