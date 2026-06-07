## Résumé

Infrastructure 100% **clickops** : Cloudflare Workers secrets, Neon branches, Upstash, R2 buckets, DNS, Turnstile — aucun Terraform/Pulumi/CDK.

## Risques

- Config drift staging vs production
- Pas de review infra en PR
- Onboarding ops lent, erreurs manuelles
- Disaster recovery non reproductible

## Solution proposée

### Phase 1 — Terraform Cloudflare provider

```hcl
resource "cloudflare_workers_script" "api" { ... }
resource "cloudflare_r2_bucket" "avatars" { ... }
resource "cloudflare_queue" "events" { ... }
```

Secrets restent hors state (reference only).

### Phase 2 — Neon provider (community) ou scripts

Branch staging/prod, roles athlya_app/cron.

### Phase 3 — CI terraform plan on PR

Workflow `.github/workflows/terraform.yml`

## Scope initial (MVP IaC)

- [ ] R2 buckets × env
- [ ] Queues × env
- [ ] Worker routes (not secret values)
- [ ] DNS records api.athlya.app

## Critères d'acceptation

- [ ] `terraform apply` reproduit staging from scratch
- [ ] README section « Infra setup » pointe Terraform
- [ ] Secrets jamais in git state

## Priorité

**P3** — quand > 2 environnements ou équipe ops

## Références

- Matrice fournisseurs README — vendor lock-in mitigation
