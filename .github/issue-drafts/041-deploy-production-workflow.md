## Résumé

Pas de workflow `deploy-production.yml`. Release = changesets tag only. Deploy API = **`wrangler deploy` manuel** sans gate `/health/ready`.

**Finding audit** : R3 / O4 — gravité **High**, priorité **P1**.

Issue #71 fermée (script `wait-health-ready.sh`) — **pas intégré pipeline**.

## Comportement attendu

```
git tag v* → CI deploy staging → smoke ready → deploy prod → smoke → notify
```

## Comportement observé

- `.github/workflows/release.yml` : pas de wrangler
- Opérateur humain = SPOF + erreurs secrets/env

## Solution proposée

### Workflow `.github/workflows/deploy-production.yml`

```yaml
on:
  workflow_dispatch:
    inputs:
      environment: [staging, production]
jobs:
  deploy:
    steps:
      - wrangler deploy --env ${{ inputs.environment }}
      - ./scripts/wait-health-ready.sh ${{ secrets.API_URL }}
      - optional: k6 smoke subset
```

### Secrets requis

`CLOUDFLARE_API_TOKEN`, URLs staging/prod

### Branch protection

Deploy prod : manual approval environment GitHub

## Critères d'acceptation

- [ ] Workflow deploy staging + prod fonctionnel
- [ ] Gate ready 503 → fail job
- [ ] Runbook deploy-production référence workflow
- [ ] Au moins 1 deploy via CI réussi

## Références

- `scripts/wait-health-ready.sh`
- `.github/workflows/release.yml`
- Issue fermée #71
- Audit prod 2026-05-27 — R3, O4

## Priorité

**P1** — maturité ops minimale
