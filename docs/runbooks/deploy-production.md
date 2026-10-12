# Deploy production — API Worker

Issue **#130**. Déploiement direct (`wrangler deploy`) avec gate **`/health/ready`** avant de considérer le job réussi.

Pour rollout graduel (5 → 25 → 100 %), voir [`canary-deploy.md`](./canary-deploy.md) (issue #129).

## Workflow CI

Fichier : [`.github/workflows/deploy-production.yml`](../../.github/workflows/deploy-production.yml)  
Actions → **Deploy API** → `workflow_dispatch`

| Phase               | Comportement                                                                     |
| ------------------- | -------------------------------------------------------------------------------- |
| `staging-deploy`    | `wrangler deploy --env staging` + `wait-health-ready.sh`                         |
| `production-deploy` | `wrangler deploy --env production` + ready gate (approbation env **production**) |
| `staging-smoke`     | Canary upload staging only (issue #129)                                          |
| `production-canary` | Canary 5→25→100 %                                                                |
| `rollback`          | Rollback Workers version                                                         |

## Prérequis

- Secrets : `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- Vars : `STAGING_API_URL`, `PRODUCTION_API_URL` (sans slash final)
- Environment GitHub **`production`** avec reviewers pour `production-deploy` / canary prod

Checklist : `node scripts/verify-deploy-production-checklist.mjs`

## Gate staging obligatoire (issue #343)

`production-deploy` et `production-canary` refusent de démarrer si le check
**Staging gate** n'a pas réussi sur le même commit
(`scripts/require-check-success.mjs`). Le workflow `staging-gate.yml` tourne
sur chaque PR vers `master` et sur chaque push sur `master` ; il **échoue**
(au lieu de sauter) quand un prérequis manque, sauf pour les PR de forks.

Prérequis du gate (environnement GitHub `staging`) :

- Secrets : `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
  `MIGRATION_DB_URL_STAGING`, `STAGING_SMOKE_EMAIL`, `STAGING_SMOKE_PASSWORD`
  (compte de smoke dédié), optionnel `STAGING_SMOKE_TURNSTILE_TOKEN`
- Vars : `STAGING_API_URL`, `K6_STAGING_BASE_URL`,
  `STAGING_SMOKE_STUDIO_SLUG` (studio seedé avec des cours à venir)

Le smoke authentifié (`smoke-routes.mjs --require-auth`) se connecte avec le
compte de smoke puis exige `200` sur `/v1/members/me` et
`/v1/reservations/me` (et `/v1/classes` si le slug studio est fourni).
Puis `scripts/smoke-e2e-login-booking.mjs` (issue #470) joue le parcours
membre : connexion → liste des cours → réservation d'une place libre →
annulation (toujours nettoyée, même en cas d'échec).

## Local (ops)

```bash
cd packages/api
wrangler deploy --env staging
bash ../../scripts/wait-health-ready.sh https://staging.api.athlya.app

wrangler deploy --env production
bash ../../scripts/wait-health-ready.sh https://api.athlya.app
```

Le script `wait-health-ready.sh` échoue (exit 1) si :

- HTTP ≠ 200 sur `/health/ready`
- body `status` ≠ `ready` (ex. `not_ready` → 503)

## Prod recommandé

Préférer **`production-canary`** pour trafic réel ; réserver **`production-deploy`** aux hotfix ou environnements sans traffic split.

## Références

- `scripts/wait-health-ready.sh` (issue #71)
- `docs/runbooks/canary-deploy.md`
- `rules.md`
