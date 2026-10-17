# Runbook — Terraform operations (issue #405)

## IaC coverage

| Resource              | Managed by Terraform     | Notes                                                                                 |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| Cloudflare Queues     | Yes (`queues.tf`)        | All envs                                                                              |
| Cloudflare R2 buckets | Yes (`r2.tf`)            | All envs                                                                              |
| Sentry metric alerts  | Yes (`sentry-alerts.tf`) | Error-volume alert on emitted error events; latency/queue/outbox stay in Axiom (#415) |
| WAF custom rules      | Yes (`waf.tf`)           | Scanner + Tor block, login rate limit (`http_ratelimit`), Bot Fight Mode opt-in       |
| Cloudflare Workers    | No — wrangler            | Managed by `deploy-production.yml`                                                    |
| CF Workers routes     | No — wrangler            | Managed by wrangler.toml `[routes]`                                                   |
| CF Access rules       | No — dashboard           | Covered by `docs/runbooks/cf-access-admin.md`                                         |
| CF Hyperdrive         | No — dashboard           | Covered by `docs/runbooks/hyperdrive-provision.md`                                    |
| Neon (DB)             | No — Neon console        | Branching handled by preview/deploy workflows                                         |
| Upstash Redis         | No — Upstash console     | Manual provisioning; keys stored as GH secrets                                        |
| Axiom alerts          | No — Axiom dashboard     | SLO monitors (latency/queue/outbox/DLQ) move to `axiom-monitors.tf` in #616           |
| DNS records           | No — CF dashboard        | Pending domain provisioning (#339)                                                    |

WAF settings depend on the zone plan: set `cloudflare_zone_plan`
(`free`/`pro`/`business`/`enterprise`) — in CI through the
`CLOUDFLARE_ZONE_PLAN` variable of each GitHub environment (default `pro`) — so the login rate limit uses the
periods and counting expression that plan supports. Bot Fight Mode stays
off (`waf_bot_fight_mode = false`) because it challenges API clients and
the Stripe webhook and cannot be bypassed on Free/Pro.

Intentionally manual resources are noted above. Drift in those is detected
via the corresponding runbook, not Terraform.

## Remote state (one-time setup)

State is remote with locking on **HCP Terraform** — the `cloud {}` block in
`infra/terraform/versions.tf` is active (issue #405). There is no local-state
fallback: `terraform init` without a backend fails instead of writing state
on a throwaway runner.

1. Create a free account at <https://app.terraform.io>.
2. Create an organisation and **two** workspaces, `athlya-staging` and
   `athlya-production`, execution mode **Local**. `TF_WORKSPACE` selects
   one; it does not create it.
3. Generate an API token: User Settings → Tokens → Create an API token.
4. GitHub: secret `TF_TOKEN_app_terraform_io` in both the `staging` and
   `production` environments, and the repository variable
   `TF_CLOUD_ORGANIZATION` (organisation slug).
5. Import the resources that already exist in Cloudflare/Sentry into each
   workspace before the first apply, otherwise Terraform will try to
   recreate them (`terraform import`, ID formats in the header of each `.tf`
   file). For example, the Sentry error alert:
   `terraform import sentry_metric_alert.error_count_spike <org-slug>/<project-slug>/<alert-rule-id>`.

CI sets `TF_WORKSPACE=athlya-<environment>`, so staging and production state
are always isolated. Locally: `export TF_CLOUD_ORGANIZATION=<org>
TF_WORKSPACE=athlya-staging` then `terraform init`.

## CI checks

- **validate** (every PR / push touching infra, no credentials): lock file
  pins every provider, `fmt -check`, `init -backend=false -lockfile=readonly`,
  `validate`.
- **plan** on PRs (skipped with a notice when the environment is not
  provisioned), **drift** daily at 06:17 UTC on production
  (`-detailed-exitcode`: exit 2 fails the run), **apply** on dispatch.
  Scheduled and dispatched runs **fail** when credentials or the backend are
  missing.

Updating providers: `terraform init -upgrade` then
`terraform providers lock -platform=linux_amd64 -platform=darwin_arm64 -platform=darwin_amd64 -platform=windows_amd64`
and commit `.terraform.lock.hcl`.

## Cloudflare provider v5 migration (one-time, per workspace)

The configuration targets `cloudflare/cloudflare ~> 5.28`. Every resource
keeps its type and address, so no `moved {}` block is needed: the v5
provider's built-in state upgraders rewrite the v4 state on the first
`plan`/`apply`. What changed in the code:

| Resource                    | v4 → v5 change                                                 |
| --------------------------- | -------------------------------------------------------------- |
| `cloudflare_queue`          | `name` → `queue_name`                                          |
| `cloudflare_r2_bucket`      | none in config; import ID is now `<account_id>/<name>/default` |
| `cloudflare_ruleset`        | `rules { … }` blocks → `rules = [{ … }]`, `ratelimit = { … }`  |
| `cloudflare_bot_management` | none                                                           |

Before the first v5 apply, for **staging first, then production**:

1. Make sure the workspace state was last written by provider 4.52.x (the
   previous pin): the upgraders only migrate state from the latest v4.
2. `gh workflow run terraform.yml -f environment=staging -f action=plan` and
   read the whole plan. Expected: no `must be replaced` and no `destroy`;
   only in-place updates of computed or defaulted attributes (e.g.
   `jurisdiction = "default"`, `storage_class = "Standard"` on R2, rule
   `ref`/`logging` on rulesets).
3. If the plan **replaces** a queue, bucket or ruleset (a state upgrader
   could not map an attribute), do not apply. Re-attach the existing object
   instead, from a shell with the workspace credentials
   (`TF_CLOUD_ORGANIZATION`, `TF_WORKSPACE`, `TF_TOKEN_app_terraform_io`,
   `TF_VAR_*`):

   ```bash
   cd infra/terraform && terraform init
   terraform state rm cloudflare_queue.events
   terraform import cloudflare_queue.events '<account_id>/<queue_id>'
   terraform state rm cloudflare_r2_bucket.avatars
   terraform import cloudflare_r2_bucket.avatars '<account_id>/athlya-avatars-<env>/default'
   terraform state rm cloudflare_ruleset.waf_custom
   terraform import cloudflare_ruleset.waf_custom 'zones/<zone_id>/<ruleset_id>'
   terraform state rm cloudflare_bot_management.main
   terraform import cloudflare_bot_management.main '<zone_id>'
   ```

   Only for the addresses the plan replaces; same pattern for the other
   queues, bucket and ruleset. IDs come from `wrangler queues list`, the R2
   dashboard and `GET /zones/<zone_id>/rulesets`. Plan again until it shows
   no replacement.

4. Apply (`-f action=apply`), then re-run `plan`: it must report no changes.
   The daily drift job then covers the workspace again.

## Required secrets

Set these in **both** the `staging` and `production` GitHub Environments.
`.github/workflows/terraform.yml` passes each one to Terraform as an env var.

| Secret                         | Purpose                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| `TF_VAR_cloudflare_api_token`  | Cloudflare API token (Workers, Queues, R2, WAF)            |
| `TF_VAR_cloudflare_account_id` | Cloudflare account ID                                      |
| `TF_VAR_cloudflare_zone_id`    | Cloudflare zone ID for athlya.app                          |
| `TF_VAR_sentry_auth_token`     | Sentry API auth token (metric alerts)                      |
| `TF_VAR_sentry_org`            | Sentry organisation slug                                   |
| `TF_VAR_sentry_project`        | Sentry project slug                                        |
| `TF_VAR_sentry_alert_team_id`  | Numeric id of the Sentry team emailed by the metric alerts |
| `TF_TOKEN_app_terraform_io`    | HCP Terraform API token (remote state, Option A)           |

## Plan → apply workflow

```bash
# Plan only (safe, no changes applied):
gh workflow run terraform.yml -f environment=production -f action=plan

# Apply (requires required-reviewer approval on the 'production' GitHub Environment):
gh workflow run terraform.yml -f environment=production -f action=apply
```

The `apply` job always runs `terraform plan` fresh first, then applies that
plan in the same runner. There is no stale artifact risk.

## Adding a new Terraform variable

1. Declare in `infra/terraform/variables.tf`.
2. Add to the `env:` block in `.github/workflows/terraform.yml` as
   `TF_VAR_<name>: ${{ secrets.TF_VAR_<name> }}`.
3. Add the secret to both the **staging** and **production** GitHub Environments.
4. Update `infra/terraform/terraform.tfvars.example`.

## Emergency break-glass

If Terraform state is locked (e.g. a prior apply crashed mid-run):

```bash
cd infra/terraform
terraform force-unlock <lock-id>
```

The lock ID is printed in the `terraform apply` error output. Only use this
after confirming no other apply is running.
