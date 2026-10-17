# Canary deploy — Cloudflare Workers

Issue **#80** (runbook) · **#129** (automation CI).  
`wrangler deploy` bascule 100 % du trafic immédiatement ; ce runbook décrit le déploiement graduel via **Workers Versions**.

## Prérequis

- Workers Paid (versions + traffic split).
- `wrangler` ≥ 3.73 avec `versions upload`.
- Baseline Sentry error rate + Axiom `http.status_code` 5xx (15 min avant canary).
- Secrets GitHub : `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
  `SENTRY_AUTH_TOKEN`, `SENTRY_DSN`.
- Variables GitHub : `STAGING_API_URL`, `PRODUCTION_API_URL`, `SENTRY_ORG`,
  `SENTRY_PROJECT` (optionnel : `CANARY_MAX_ERRORS`).
- Secret Worker `SENTRY_DSN` sur la gateway et les trois sub-workers
  (`node scripts/verify-secrets.mjs --env production`).

Checklist ops : `node scripts/verify-canary-deploy-checklist.mjs`

## CI — workflow GitHub (recommandé)

Workflow : [`.github/workflows/deploy-production.yml`](../../.github/workflows/deploy-production.yml)  
Actions → **Deploy API** → `workflow_dispatch`

| Phase               | Action                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `staging-smoke`     | `versions upload` staging + gate `/health/ready`                                                     |
| `production-canary` | staging ready → upload prod → **5 %** (10 min) → **25 %** (10 min) → **100 %** (10 min) + ready prod |
| `rollback`          | `wrangler rollback` production (option `version_id`)                                                 |

Environment GitHub **`production`** : approbation manuelle obligatoire avant canary/rollback.

## Gates de promotion (issue #404)

À **chaque** palier, 100 % compris (1 % → 10 % → 100 % automatique, 5 → 25 → 100 % manuel) :

1. **Accessibilité des routes** (`scripts/smoke-routes.mjs`, passe non
   authentifiée) juste après le basculement de trafic : chaque groupe de
   routes répond sans 5xx. À 1 % / 5 % / 10 %, la plupart de ces requêtes
   tombent encore sur l'ancienne version : c'est un contrôle
   d'**accessibilité** du parc, pas de santé du canary (et il ne voit pas
   les régressions 4xx). La santé de la release est mesurée par le gate 3.
2. **Fenêtre de bake** : `/health/ready` toutes les 60 s (2 échecs
   consécutifs → abort).
3. **Budget d'erreurs** : nombre d'erreurs Sentry de la release
   (`VERSION` = SHA court du commit, 7 caractères, injecté par
   `--var VERSION:<sha7>` sur la gateway **et** les trois sub-workers) sur la
   fenêtre ; au-delà de `CANARY_MAX_ERRORS` (défaut 5) → abort et rollback.
   Une erreur de l'API Sentry fait échouer le gate (fail-closed).
   `CANARY_MAX_ERRORS` vide = défaut ; toute valeur qui n'est pas un entier
   ≥ 0 (`abc`, `-1`, `1.5`) fait échouer la configuration.

Le palier 100 % a donc lui aussi sa fenêtre de bake et son budget : le
canary ne rapporte un succès qu'une fois la release tenue à 100 %. Avec trois
fenêtres, `wait_minutes` du workflow manuel est limité à 1-20.

Prérequis obligatoires (le workflow **échoue** sinon) : `SENTRY_AUTH_TOKEN`,
`SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_DSN` (secret GitHub), et les secrets
Workers vérifiés par `scripts/verify-secrets.mjs --env production` (dont
`SENTRY_DSN` sur les quatre Workers — sans lui le budget compterait zéro
erreur et promouvrait à l'aveugle). Les déclencheurs de `canary.yml` couvrent
tout le graphe runtime de `@athlya/api`, la config de build qu'il étend
(`packages/tsconfig`), le lockfile, et chaque script exécuté par le workflow
avec ses imports locaux, vérifié en CI par `pnpm check:canary-paths`.

### Latency gate (#415)

After the error budget, every step (100 % included) times
`CANARY_LATENCY_SAMPLES` (default 20) sequential `/health/ready` requests
pinned to the canary with the `Cloudflare-Workers-Version-Overrides:
athlya-api-production="<version-id>"` header
(`scripts/canary-latency.mjs`). At 1 % / 5 % ordinary traffic would mostly
hit the previous version; the override makes every sample measure the new
one, and each answer must carry the canary `version` (`<sha7>`), otherwise
the gate fails. `/health/ready` exercises Postgres, Redis, R2 and the cron
state, so its p95 tracks the latency the release adds. A p95 above
`CANARY_MAX_P95_MS` (default 1500 ms, measured from the CI runner, network
included), any non-ready answer, or a sample served by another version
aborts the canary and rolls back. Both variables are optional repository
variables; an invalid value (not an integer in range) fails the run. Tune
`CANARY_MAX_P95_MS` from the p95 the first canaries log
(`latency at <step>: …`).

### Source maps and Sentry release (#415)

Both canary paths (`canary.yml` and the `production-canary` phase of
`deploy-production.yml`) upload the gateway version with
`canary-deploy.mjs upload --outdir dist` (no traffic shift), then run
`scripts/sentry-release.sh prepare production` (release `<sha7>`, source
maps of the gateway and of every sub-worker bundled in this run), and only
then promote that exact version with `production-canary --version-id`. Once
the release held at 100 %, `sentry-release.sh finalize production`
finalizes it and records the deploy marker. Missing Sentry configuration
fails the run. Details: [`sentry-sourcemaps.md`](./sentry-sourcemaps.md).

### Pas de smoke authentifié en production (décision)

`/v1/auth/login` est protégé par Turnstile ; en production le secret est
réel et chaque token est à usage unique, donc la CI ne peut pas en fournir un
par palier (un token statique échoue dès la deuxième connexion, et un bearer
pré-émis expire au bout de 15 min, avant la fin d'un canary). Le canary de
production exécute donc **uniquement** la passe non authentifiée ; la passe
authentifiée tourne sur staging (`staging-gate.yml`, clés de test Turnstile,
`STAGING_SMOKE_*`). Turnstile n'est **pas** assoupli sur la route de login.
Les secrets `PRODUCTION_SMOKE_EMAIL` / `PRODUCTION_SMOKE_PASSWORD` ne sont
plus lus.

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
