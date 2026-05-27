# Terraform IaC — ADR (issue #84)

**Statut** : accepté en attente — clickops suffisant pour pilote solo ; Terraform quand ≥ 2 envs gérés par une équipe ops.

## Contexte

Bindings aujourd'hui : `wrangler.toml`, secrets `wrangler secret put`, Neon console, Upstash, R2, DNS Cloudflare. Pas de drift detection en PR.

## Décision

### Phase 1 (MVP state)

Provider `cloudflare` :

- `cloudflare_workers_script` / routes `api.athlya.app`
- `cloudflare_r2_bucket` avatars + exports × env
- `cloudflare_queue` events + DLQ × env
- DNS records (CNAME)

Secrets **hors** state Terraform (références uniquement).

### Phase 2

Neon branch + rôles via provider community ou scripts `packages/db/scripts/`.

### Phase 3

CI `terraform plan` sur PR (`.github/workflows/terraform.yml`).

## Critères avant migration

- [ ] README « Infra setup » pointe ici
- [ ] `terraform apply` recrée staging sans secrets dans git
- [ ] Runbook rollback documenté

## Références

- README matrice fournisseurs
- `packages/api/wrangler.toml`
