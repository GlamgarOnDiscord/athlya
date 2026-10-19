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

`production-deploy` et `production-canary` refusent de démarrer si les checks
**Staging gate** et **Staging gate (full soak)** n'ont pas tous deux réussi
sur le même commit (`scripts/require-check-success.mjs --check … --check …`).
Le workflow `staging-gate.yml` tourne sur chaque PR vers `master` et sur
chaque push sur `master` ; il **échoue** (au lieu de sauter) quand un
prérequis manque, sauf pour les PR de forks et les runs Dependabot.

### Durée du soak k6

L'issue #343 exige un soak de **10 minutes** avant la production. Le lancer
sur chaque PR bloquerait l'environnement staging partagé 10+ minutes par push,
d'où la répartition (`scripts/staging-gate-soak.mjs`) :

| Déclencheur         | Soak k6                                     | Preuve de release ? |
| ------------------- | ------------------------------------------- | ------------------- |
| `pull_request`      | 2 min                                       | non                 |
| push sur `master`   | 10 min (toujours)                           | oui                 |
| `workflow_dispatch` | input `soak_duration` (défaut `10m`, ≤ 30m) | oui si ≥ 10 min     |

Le soak complet est prouvé par la durée mesurée par k6
(`state.testRunDurationMs` du résumé `k6-book-class-summary.json`, uploadé
dans l'artifact `k6-staging-gate-summary`), pas par la durée demandée. Seul
un run prouvé ≥ 10 min déclenche le job **Staging gate (full soak)** ; sur
une PR ou un run manuel plus court, ce job est `skipped`, et un run `skipped`
ne compte ni pour ni contre (la vérification ne retient que le dernier run
terminé non sauté). Un commit qui n'a passé que le soak de PR ne peut donc
pas partir en production. Si le push n'a pas produit le check (run en
attente remplacé par un plus récent dans le groupe `staging-environment`, par
exemple), relancer ce run-là depuis l'onglet Actions (`gh run rerun <run-id>`) :
il rejoue le même SHA. `gh workflow run staging-gate.yml --ref master` ne
convient que si ce commit est encore la tête de `master`, car `--ref` prend
une branche ou un tag, pas un SHA : sur un commit plus ancien, le check
atterrirait sur la nouvelle tête. Sinon, déployer le commit plus récent dont
le push a produit les deux checks.

Le job `staging-gate` a un timeout de 60 min ; un push sur `master` occupe
staging environ 15 min (déploiement, smoke, migrations, soak), les runs de PR
attendent leur tour dans le groupe de concurrence.

Prérequis du gate (environnement GitHub `staging`) :

- Secrets : `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
  `MIGRATION_DB_URL_STAGING`, `STAGING_SMOKE_EMAIL`, `STAGING_SMOKE_PASSWORD`
  (compte de smoke dédié), optionnel `STAGING_SMOKE_TURNSTILE_TOKEN`
- Vars : `STAGING_API_URL`, `K6_STAGING_BASE_URL`,
  `STAGING_SMOKE_STUDIO_SLUG` (studio seedé avec au moins un cours à venir
  ayant une place libre)

Le smoke authentifié (`smoke-routes.mjs --require-auth`) se connecte avec le
compte de smoke puis exige `200` sur `/v1/members/me` et
`/v1/reservations/me` (et `/v1/classes` si le slug studio est fourni).
Puis `scripts/smoke-e2e-login-booking.mjs` (issue #470) joue le parcours
membre en réutilisant cette session (un token Turnstile est à usage unique) :
liste des cours → réservation d'une place libre → annulation. L'annulation
est tentée même en cas d'échec ou d'annulation du run ; si elle échoue, le
log indique l'id de la réservation à annuler manuellement.

`STAGING_SMOKE_TURNSTILE_TOKEN` n'est utile qu'avec la clé secrète Turnstile
de test de Cloudflare sur staging : un vrai token expire et ne sert qu'une
fois, il ne peut donc pas être stocké en secret.

### Secrets Worker vérifiés (`scripts/verify-secrets.mjs`)

La sous-vérification 1 du gate (et `staging-deploy` / `production-deploy`)
liste les secrets de chaque Worker via `wrangler secret list`. Chaque Worker
a ses propres secrets (aucun héritage entre configs wrangler) :

| Worker (config)                             | Requis (staging + production)                                                                                                                                                                                                                                                    | Production uniquement                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| gateway (`wrangler.toml`)                   | `DB_URL`, `REDIS_*`, JWT, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_PRO`, `BILLING_REDIRECT_URL`, `BILLING_DB_URL`, `CRON_DB_URL`, `TURNSTILE_SECRET`, `CORS_ORIGIN`, `RESEND_API_KEY`, `EXPORT_URL_SIGNING_KEY`, `PASSWORD_RESET_TOKEN_KEY`, `WEB_APP_URL` | `SENTRY_DSN`, `OTEL_*`, `CF_ACCESS_*` |
| auth (`wrangler.auth.toml`)                 | `DB_URL`, `REDIS_*`, JWT, `CORS_ORIGIN`, `TURNSTILE_SECRET`, `RESEND_API_KEY`                                                                                                                                                                                                    | `SENTRY_DSN`, `OTEL_*`                |
| reservations (`wrangler.reservations.toml`) | `DB_URL`, `REDIS_*`, JWT, `CORS_ORIGIN`, `EXPORT_URL_SIGNING_KEY`                                                                                                                                                                                                                | `SENTRY_DSN`, `OTEL_*`                |
| billing (`wrangler.billing.toml`)           | `DB_URL`, `REDIS_*`, JWT, `CORS_ORIGIN`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_PRO`, `BILLING_REDIRECT_URL`, `BILLING_DB_URL`                                                                                                                           | `SENTRY_DSN`, `OTEL_*`, `CF_ACCESS_*` |

JWT = `JWT_KID`, `JWT_PRIVATE_KEY_PEM`, `JWT_PUBLIC_KEY_PEM`, `JWKS_JSON`,
`JWT_JWKS_URL`. Le gateway garde une copie des secrets Stripe/billing pour le
fallback `*.workers.dev` (voir `stripe-production.md`). Le billing Worker sert
`/admin/*`, d'où `CF_ACCESS_*` en production. Les en-têtes `# Secrets` des
configs wrangler des sub-workers donnent la même liste ;
`scripts/__tests__/verify-secrets.test.mjs` échoue si les deux divergent ou si
un secret vérifié par `assertRequiredSecrets()` manque.

Bindings (not secrets, declared in each wrangler config): the reservations
Worker binds `HYPERDRIVE` (staging, production) and the `AVATARS_BUCKET` /
`EXPORTS_BUCKET` R2 buckets in every env, with the gateway's bucket names,
because it serves `/v1/members/*` (issue #625). Its `/health/ready` probes
both buckets. `packages/api/src/__tests__/worker-routing.test.ts` fails if a
Worker mounts `/v1/members` without both R2 bindings in one of its envs, with
a bucket or an `AVATARS_PUBLIC_URL` var that differs from the gateway's, or
without `EXPORT_URL_SIGNING_KEY` in its `# Secrets` header. If
`AVATARS_PUBLIC_URL` is ever set as a secret instead of a var, set it on both
Workers.

Optional secrets (`OPTIONAL` in `verify-secrets.mjs`, `# Optional` header line of the wrangler
configs) are only warned about when missing: `MISTRAL_API_KEY` on the gateway and the
reservations Worker, for the AI coach behind the `ai-coach` flag (OFF by default). Without it the
coach answers 503 `coach_not_configured` once the flag is on. `MISTRAL_BASE_URL` (optional var, `https:` on a `mistral.ai`
host only, otherwise the coach answers 503 `coach_not_configured`) points the coach at a regional
Mistral endpoint ([`ai-coach.md`](../compliance/ai-coach.md)). The flag catalogue itself is the
optional `FEATURE_FLAGS_JSON` var or secret ([`feature-flags.md`](../operations/feature-flags.md)).

The reservations Worker also serves `/v1/me/*` (`GET /v1/me/progression`,
issue #639) from the same members deps, through its own
`staging.api.athlya.app/v1/me/*` and `api.athlya.app/v1/me/*` zone routes.
Both routes live in the named environments, so they are created by the
first `wrangler deploy --config wrangler.reservations.toml --env staging`
(and `--env production`) after that change; a deploy without `--env` creates
none. Until then the gateway's catch-all `/*` route serves the path, so there
is no gap.

The same holds for the AI coach (issue #644): `staging.api.athlya.app/v1/coach` and
`/v1/coach/*` (and the production pair) route to the reservations Worker. Both patterns are
needed because `/v1/coach/*` does not match the bare `GET /v1/coach`;
`worker-routing.test.ts` fails if an exact route lacks its `/*` sibling.

### Enabling the AI coach (Epic 21)

The coach ships dark: the `ai-coach` flag is OFF and `MISTRAL_API_KEY` is optional. Without the
key, a flag-on member gets 503 `coach_not_configured`; nothing else is affected. To open it in an
environment (staging first):

1. Go through the RGPD operator checklist in [`ai-coach.md`](../compliance/ai-coach.md#operator-checklist)
   (DPA, region, retention, training opt-out).
2. Set the key on **both** Workers that serve `/v1/coach` (gateway and reservations). Wrangler
   prompts for the value; never pass it on the command line:

   ```bash
   cd packages/api
   wrangler secret put MISTRAL_API_KEY --env staging
   wrangler secret put MISTRAL_API_KEY --config wrangler.reservations.toml --env staging
   ```

   Optional vars on both Workers: `AI_COACH_MODEL` (default `mistral-small-latest`),
   `AI_COACH_DAILY_LIMIT` (default 10), `MISTRAL_BASE_URL` (regional `https://…mistral.ai`
   endpoint only).

3. Open the flag for a staff allow-list in `FEATURE_FLAGS_JSON` on both Workers
   ([`feature-flags.md`](../operations/feature-flags.md)), e.g.
   `{"ai-coach":{"rollout":0,"allowList":["<staff user id>"]}}`, through
   `wrangler secret put FEATURE_FLAGS_JSON [--config wrangler.reservations.toml] --env staging`.
4. Check from a staff account: `GET /v1/coach` answers `enabled: true`, then
   `POST /v1/coach/ask` answers 200 both as JSON and with `Accept: text/event-stream`
   (`partial` events, then one `done` event; issue #675).
5. Repeat with `--env production`, then widen the rollout by phase.

To switch the coach off, set `"ai-coach": false`; removing the key also stops every provider call
(503 `coach_not_configured`).

The streamed answer needs nothing extra at the edge: the zone routes pass `text/event-stream`
through unbuffered, and the response carries `Cache-Control: no-store`. A client disconnect
aborts the Mistral call; the daily quota is counted before the call either way.

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

## Rollback automatique après la release (CN.7.3)

Une fois le canary terminé, [`slo-rollback.yml`](../../.github/workflows/slo-rollback.yml)
remet les quatre Workers de production (gateway, auth, reservations, billing)
sur leur version précédente si le 5xx dépasse 2 % ou le p99 2 000 ms pendant
10 minutes consécutives — ou ne touche à rien si un garde-fou bloque (canary en
cours, secret changé, migration `-- athlya:contract`, cool-down…). Il est
inactif tant que `vars.AUTO_ROLLBACK_ENABLED` ≠ `true` et que les monitors
Axiom ne sont pas activés. Le rollback manuel `rollback.yml` (et la phase
`rollback` de `deploy-production.yml`) ne revient que sur la gateway. Setup et
garde-fous :
[`automatic-rollback.md`](./automatic-rollback.md).

## Références

- `scripts/wait-health-ready.sh` (issue #71)
- `docs/runbooks/canary-deploy.md`
- `docs/runbooks/automatic-rollback.md` (CN.7.3)
- `rules.md`
