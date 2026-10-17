# Canary deploy — Cloudflare Workers

Issue **#80** (runbook) · **#129** (automation CI).  
`wrangler deploy` bascule 100 % du trafic immédiatement ; ce runbook décrit le déploiement graduel via **Workers Versions**.

## Prérequis

- Workers Paid (versions + traffic split).
- `wrangler` ≥ 3.73 avec `versions upload`.
- Baseline Sentry error rate + Axiom `http.status_code` 5xx (15 min avant canary).
- Secrets GitHub : `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- Variables GitHub : `STAGING_API_URL`, `PRODUCTION_API_URL`.

Checklist ops : `node scripts/verify-canary-deploy-checklist.mjs`

## CI — workflow GitHub (recommandé)

Workflow : [`.github/workflows/deploy-production.yml`](../../.github/workflows/deploy-production.yml)  
Actions → **Deploy API** → `workflow_dispatch`

| Phase               | Action                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `staging-smoke`     | `versions upload` staging + gate `/health/ready`                                            |
| `production-canary` | staging ready → upload prod → **5 %** (10 min) → **25 %** (10 min) → **100 %** + ready prod |
| `rollback`          | `wrangler rollback` production (option `version_id`)                                        |

Environment GitHub **`production`** : approbation manuelle obligatoire avant canary/rollback.

## Gates de promotion (issue #404)

À chaque palier (1 % → 10 % → 100 % automatique, 5 → 25 → 100 % manuel) :

1. **Smoke par route** (`scripts/smoke-routes.mjs`) juste après le
   basculement de trafic — authentifié si `PRODUCTION_SMOKE_EMAIL` /
   `PRODUCTION_SMOKE_PASSWORD` sont fournis.
2. **Fenêtre de bake** : `/health/ready` toutes les 60 s (2 échecs
   consécutifs → abort).
3. **Budget d'erreurs** : nombre d'erreurs Sentry de la release
   (`VERSION` = SHA du commit, injecté par `--var VERSION:<sha>`) sur la
   fenêtre ; au-delà de `CANARY_MAX_ERRORS` (défaut 5) → abort et rollback.
   Une erreur de l'API Sentry fait échouer le gate (fail-closed).

Prérequis obligatoires (le workflow **échoue** sinon) : `SENTRY_AUTH_TOKEN`,
`SENTRY_ORG`, `SENTRY_PROJECT`. Les déclencheurs de `canary.yml` couvrent tout
le graphe runtime de `@athlya/api` + le lockfile, vérifié en CI par
`pnpm check:canary-paths`.

## Script local / CI

```bash
# Staging seul (upload + ready)
node scripts/canary-deploy.mjs staging-smoke --base-url https://staging.api.athlya.app

# Production canary complet
node scripts/canary-deploy.mjs production-canary \
  --base-url https://api.athlya.app \
  --staging-url https://staging.api.athlya.app \
  --wait-min 10 \
  --steps 5,25,100

# Étapes manuelles
node scripts/canary-deploy.mjs upload --env production --message "release-xyz"
node scripts/canary-deploy.mjs promote --env production --version-id <id> --percent 5
node scripts/canary-deploy.mjs rollback --env production
```

Gate ready : poll `/health/ready` (HTTP 200 + `status: ready`) — même contrat que `scripts/wait-health-ready.sh`.

## Staging (dry-run traffic split)

```bash
cd packages/api
wrangler versions upload --env staging --message "canary-test-$(git rev-parse --short HEAD)"
```

Critères go : 5xx rate ≤ baseline × 1.2, pas de spike `auth.login` p95 (Axiom A2).

## Production (manuel dashboard)

1. **Upload** nouvelle version sans promouvoir 100 %.
2. **5 %** trafic 15 min → monitor.
3. **25 %** 15 min si OK (issue #129 ; runbook #80 mentionnait 50 % — préférer 25 % intermédiaire).
4. **100 %** ou **rollback** vers version précédente (< 5 min).

Rollback d'urgence :

```bash
node scripts/canary-deploy.mjs rollback --env production
# ou
wrangler rollback --env production -y
```

Critères rollback auto (Phase 3 — monitoring manuel v1) :

- 5xx rate > baseline × 1.5 pendant 5 min (Axiom A1)
- Sentry new issue rate spike vs baseline
- `/health/ready` → `not_ready` sur prod pendant 2 polls consécutifs

## Références

- [Cloudflare gradual deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/)
- `docs/operations/axiom-alerts.md` A1, A11
- `rules.md` § workflow PR + Copilot review
- `.kiro/specs/athlya-platform/critique.md` C2.x
