# Canary deploy — Cloudflare Workers

Issue **#80**. `wrangler deploy` bascule 100 % du trafic immédiatement ; ce runbook décrit le déploiement graduel via **Workers Versions**.

## Prérequis

- Workers Paid (versions + traffic split).
- `wrangler` ≥ 3.73 avec `versions upload`.
- Baseline Sentry error rate + Axiom `http.status_code` 5xx (15 min avant canary).

## Staging (dry-run)

```bash
cd packages/api
wrangler versions upload --env staging --message "canary-test-$(git rev-parse --short HEAD)"
# Traffic split via dashboard Zero Trust / Workers Versions
# ou API account : PATCH traffic → 90/10 pendant 15 min
```

Critères go : 5xx rate ≤ baseline × 1.2, pas de spike `auth.login` p95 (Axiom A2).

## Production

1. **Upload** nouvelle version sans promouvoir 100 %.
2. **5 %** trafic 15 min → monitor.
3. **50 %** 15 min si OK.
4. **100 %** ou **rollback** vers version précédente (< 5 min via dashboard Versions → « Roll back »).

Rollback d'urgence : `wrangler rollback --env production` (dernier deploy stable).

## CI (futur)

Pipeline suggéré : job `canary-promote` manuel après smoke `scripts/wait-health-ready.sh` + check Axiom. Pas de script `canary-deploy.mjs` en v0.1 — ops manuel.

## Références

- [Cloudflare gradual deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/)
- `docs/operations/axiom-alerts.md` A1, A11
- `.kiro/specs/athlya-platform/critique.md` C2.x
