# Runbook — Terraform operations (issue #405)

## IaC coverage

| Resource              | Managed by Terraform     | Notes                                                                        |
| --------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| Cloudflare Queues     | Yes (`queues.tf`)        | All envs                                                                     |
| Cloudflare R2 buckets | Yes (`r2.tf`)            | All envs                                                                     |
| Sentry metric alerts  | Yes (`sentry-alerts.tf`) | 5 alerts provisioned (error rate, p99, queue lag, outbox backlog, readiness) |
| WAF custom rules      | Yes (`waf.tf`)           | Scanner block + Bot Fight Mode                                               |
| Cloudflare Workers    | No — wrangler            | Managed by `deploy-production.yml`                                           |
| CF Workers routes     | No — wrangler            | Managed by wrangler.toml `[routes]`                                          |
| CF Access rules       | No — dashboard           | Covered by `docs/runbooks/cf-access-admin.md`                                |
| CF Hyperdrive         | No — dashboard           | Covered by `docs/runbooks/hyperdrive-provision.md`                           |
| Neon (DB)             | No — Neon console        | Branching handled by preview/deploy workflows                                |
| Upstash Redis         | No — Upstash console     | Manual provisioning; keys stored as GH secrets                               |
| Axiom alerts          | No — Axiom dashboard     | Covered by `docs/runbooks/axiom-alerts-provision.md`                         |
| DNS records           | No — CF dashboard        | Pending domain provisioning (#339)                                           |

Intentionally manual resources are noted above. Drift in those is detected
via the corresponding runbook, not Terraform.

## Remote state (one-time setup)

Terraform state must be remote with locking before production applies.
Choose one backend:

### Option A — HCP Terraform (recommended, free tier)

1. Create a free account at <https://app.terraform.io>.
2. Create an organisation and a workspace named `athlya-production`.
3. Set workspace execution mode to **Local** (Terraform runs in CI, not HCP).
4. Generate an API token: User Settings → Tokens → Create an API token.
5. Add `TF_TOKEN_app_terraform_io` to the **production** GitHub Environment secret.
6. Uncomment the `cloud {}` block in `infra/terraform/versions.tf`.
7. Run `terraform init` locally to migrate existing state (if any).

### Option B — S3 + DynamoDB

1. Create an S3 bucket (`athlya-tf-state`) in `eu-central-1` with versioning enabled.
2. Create a DynamoDB table (`athlya-tf-locks`) with partition key `LockID` (String).
3. Add AWS credentials to GitHub Environment secrets (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`).
4. Uncomment the `backend "s3" {}` block in `infra/terraform/versions.tf`.
5. Add the AWS env vars to `.github/workflows/terraform.yml`.

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
