# Athlya Platform — Progress & Remaining Work

**Dernière mise à jour :** Session 2026-10-17/18 — clôture des issues : 45 PRs mergées sur `master`, 31 issues fermées (dont les P0 #117, #122, #224, #405, #404, #497, #498), migrations 0031 → 0041 livrées (#628, purge RGPD, fermée par #630). Le code est complet côté repo ; il reste des étapes opérateur, consolidées dans la section [Session 2026-10-17/18 — clôture des issues](#session-2026-101718--clôture-des-issues).
**Mise à jour précédente :** Session 2026-06-16 — Ops sprint: migrations Neon 0000-0017 appliquées sur staging+production, RLS cutover `athlya_app` (NOBYPASSRLS — piège Console Neon documenté → role recréé via SQL), Stripe secrets + webhooks (staging PR #269 + prod PR #292), R2 buckets + Queues Cloudflare provisionnés, JWT keypairs générés, Upstash Redis configuré. Issues closes : #268 (PR #291), #270 (PR #292), #279 (direct). + esbuild/postcss overrides (#290), Sentry CRON alert (#286). Tasks.md CN.6.4 cochée (PR #293 — code existait déjà). Compteur vérifié : **283 / 313 tâches**.
**Tâches complétées :** Epic 14 (1/1), Epic 15 (3/3), Epic 16 (3/3), Epic 17 (1/1), CN.6.4 (cochée PR #293), CN.8.1, CN.8.2, CN.9.2, CN.9.3 — cases parents cochées
**Hardening tasks livrées :** 8 / 8 (H1 à H8) + 6 issues GitHub (#47–#53 #56) + 8 Dependabot alerts (PR #58)
**Niveau 2 (live wiring) :** 13 / 13 items ✅ COMPLET (voir section dédiée)

---

## Session 2026-10-17/18 — clôture des issues

Session de clôture du backlog P0/P1 ouvert par l'audit : RLS-safe sous les rôles runtime `NOBYPASSRLS`, outbox, export RGPD, billing Stripe, bulkhead Workers, canary, staging gate, Terraform, observabilité, déploiement frontend. Tout le code est sur `master` (tête `55f39f7`). Les issues fermées « code-complete » laissent des étapes opérateur, regroupées dans la [checklist opérateur](#checklist-opérateur-consolidée) ci-dessous.

Aucune case de `tasks.md` ne bouge : ces issues sortent de l'audit et ne correspondent à aucune tâche du plan. CN.7.3 (rollback auto sur SLO breach via Slack/PagerDuty) reste ouverte ; le gate error budget du canary (#579) n'en couvre qu'une partie.

### PRs mergées (2026-10-17 → 2026-10-18)

| PR   | Titre                                                                                       | Commit    | Issue               |
| ---- | ------------------------------------------------------------------------------------------- | --------- | ------------------- |
| #602 | fix(web): shrink oversized PNGs below the 500 KiB CI hygiene limit                          | `7c98187` | Closes #601         |
| #600 | fix(deps): clear OSV lockfile findings for undici and braces                                | `4867a3f` | Closes #598         |
| #585 | test(db/rls): fix three pgTAP files that were red on master                                 | `2cd07d2` | —                   |
| #577 | fix(infra/waf): move login rate limit to an http_ratelimit ruleset                          | `170c894` | Refs #339           |
| #599 | docs: refresh stack versions and conventions after toolchain upgrade                        | `7bc00a8` | Closes #597         |
| #576 | ci(zap): fail closed when the DAST target is missing on trusted runs                        | `8b497df` | Refs #340           |
| #604 | fix(ci): harden workflows and keep k6 tokens out of summaries                               | `5d59bc0` | Closes #603         |
| #578 | ci(staging-gate): fail closed on trusted runs and gate prod on the same SHA                 | `33e4649` | Refs #343           |
| #586 | fix(outbox): make the outbox producible and drainable without BYPASSRLS                     | `39ca897` | Refs #497           |
| #594 | fix(frontend): make web and studio deployable as OpenNext Workers                           | `9566d05` | Refs #422           |
| #587 | fix(db): RLS-safe service functions for pre-auth and queue adapters                         | `e03111a` | Refs #224           |
| #588 | fix(auth): record auth.user events atomically with their mutation                           | `26416f5` | Refs #411           |
| #579 | feat(canary): gate promotion on route smoke and the release error budget                    | `ddc96c2` | Refs #404           |
| #608 | fix(infra): post-merge review findings on WAF, staging gate and frontend deploy             | `c9835fd` | Closes #606         |
| #607 | fix(canary): address review findings on the error-budget gate (#579 follow-up)              | `3a02f38` | Closes #605         |
| #580 | fix(observability): alert on signals the runtime emits and inject VERSION                   | `c514904` | Refs #415           |
| #581 | fix(preview): make per-PR preview Workers actually serve the PR                             | `74f1fdf` | Refs #419           |
| #589 | fix(members): make the RGPD export functional under athlya_app                              | `3baf4b6` | Refs #498           |
| #582 | fix(infra/terraform): enforce remote state, lock providers, detect drift                    | `a33f2b4` | Refs #405           |
| #583 | feat(release): E2E booking smoke on staging and a full config inventory                     | `f5a0e6f` | Refs #470, #471     |
| #590 | fix(outbox): lease-based drain without locks across queue sends                             | `7fef6ca` | Refs #424           |
| #591 | feat(outbox): drain the backlog within one cycle and prioritise compliance events           | `62f22d7` | Refs #311           |
| #592 | feat(db): verify the runtime role contract for every workload                               | `f9c7c39` | Refs #117           |
| #584 | refactor(api): isolate bulkhead workers from the monolith entry point                       | `1097d15` | Refs #230           |
| #593 | feat(billing): operational studio subscription checkout, invoices and webhooks              | `c643f3d` | Refs #122           |
| #612 | fix: post-merge review findings on #581 and #589                                            | `988cf27` | Closes #611         |
| #610 | fix(auth/outbox): post-merge review findings on auth event recording and service functions  | `db49e06` | Closes #609         |
| #595 | chore(deps): bump the prod-minor-patch group across 1 directory with 8 updates              | `ba52a51` | —                   |
| #570 | chore(deps): bump the github-actions group across 1 directory with 8 updates                | `ee57b23` | —                   |
| #541 | chore(deps): bump actions/setup-node from 6.4.0 to 7.0.0                                    | `7185d03` | —                   |
| #542 | chore(deps): bump actions/attest-sbom from 2.4.0 to 4.1.0                                   | `217d2d3` | —                   |
| #615 | ci(staging-gate): prove a 10-minute soak before production and align verify-secrets         | `625244d` | Closes #343         |
| #617 | fix(members): complete RGPD export — v1 invoice decision and staging E2E                    | `df57657` | Closes #498         |
| #618 | fix(db,api): make studios reads, updates and slug resolution RLS-safe                       | `ebb3cd2` | Closes #224, Refs #117, #470 |
| #616 | fix(observability): canary source maps + Axiom SLO monitors as code (#415)                  | `d4edc51` | Closes #415         |
| #596 | chore(deps-dev): bump the dev-minor-patch group across 1 directory with 11 updates          | `7c24b9d` | —                   |
| #620 | feat(frontend): browser release smoke against the deployed web and studio                   | `23e3ca6` | Closes #422         |
| #621 | fix(db,api): close the remaining athlya_app runtime RLS gaps                                | `5dca04b` | Refs #117           |
| #619 | fix(infra): migrate Terraform to Cloudflare provider v5                                     | `ca06ba0` | Refs #405           |
| #622 | feat(outbox): event-driven drain kick and configurable batch size                           | `95daebf` | Closes #311         |
| #623 | fix(api): key mutation rate limits on the authenticated user                                | `85f6a68` | Closes #613         |
| #624 | feat(api): scope /health/ready probes to each Worker's bindings                             | `3aec21d` | Closes #614         |
| #626 | fix(db,api): waitlist promotion and capacity reconcile under the runtime roles              | `589c588` | Refs #117           |
| #627 | fix(api): bind avatar and export R2 buckets on the reservations Worker                      | `356019b` | Closes #625         |
| #630 | fix(db,api): make users.email nullable so the RGPD purge can anonymise users                | `55f39f7` | Closes #628         |

Migrations livrées : 0031 (#586), 0032 (#587), 0033 (#588), 0034 (#589), 0035 (#590), 0036 (#593), 0037 (#610), 0038 (#618), 0039 (#621), 0040 (#626), 0041 (#630).

### Issues fermées et pourquoi

**Fermées par leur PR (`Closes`)** — correctifs complets, aucune étape opérateur propre :

- #601 (PNGs > 500 KiB qui cassaient le check requis) → #602
- #598 (findings OSV undici/braces) → #600
- #597 (docs et conventions après l'upgrade toolchain) → #599
- #603 (durcissement workflows + tokens k6 hors summaries, audit repo public) → #604
- #605, #606, #609, #611 (findings de review post-merge) → #607, #608, #610, #612
- #613 (rate limit des mutations par utilisateur, après `jwtAuth`) → #623
- #614 (`/health/ready` restreint aux bindings de chaque Worker) → #624
- #625 (buckets R2 avatars/exports liés au Worker reservations) → #627

**Fermées par leur PR, étapes opérateur restantes** :

- #343 staging gate qui prouve le système déployé → #578 + #615 (soak de 10 min avant prod)
- #415 observabilité prod et rollback SLO non optionnels → #580 + #616 (source maps, moniteurs Axiom en Terraform)
- #498 export RGPD fonctionnel, durable, contrôlé → #589 + #617 (factures v1 : décision documentée)
- #224 adapters pré-auth/background RLS-safe → #587 + #618 (studios, résolution de slug)
- #422 web/studio déployables + smoke réel → #594 + #620 (la description de #620 avait été écrasée avant merge ; issue fermée à la main, description restaurée)
- #311 drain outbox mesurable et scalable → #591 + #622 (kick événementiel ; débits modélisés, pas encore mesurés)

**Fermées « code-complete » à la main** (critères repo atteints, étapes opérateur listées dans le dernier commentaire de l'issue) :

- #117 cutover rôles runtime RLS-safe → #592, #610, #618, #621, #626. Défaut restant extrait dans #628, corrigé depuis par #630.
- #122 Stripe checkout/factures/webhooks → #593 (Stripe Connect pour les paiements membres hors scope)
- #230 trafic prod via les bulkhead Workers → #584
- #339 ruleset WAF rate limit → #577
- #340 ZAP baseline + active réels → #576
- #404 ordre de déploiement canary + rollback sur métriques → #579
- #405 state Terraform + IaC → #582, #616, #619
- #411 événements auth durables → #588, #610
- #419 previews par PR → #581, #612
- #424 plus de locks DB autour des envois queue → #590, #591
- #470 E2E staging (domaine custom pour l'allowlist Host) → #583, #618
- #471 infra prod avant v1.0.0 → #583, #593 (le reste = launch checklist)
- #497 pipeline outbox RLS-safe → #586, #590, #591, #610

### Purge RGPD — #628 fermée par #630 (`55f39f7`)

- ✅ **#628 [P1][rgpd][db] — la purge RGPD échouait en `23502`** : `users.email` était resté `NOT NULL` depuis `0000_init.sql`, donc chaque tick de `anonymizeExpiredUsers` échouait et les comptes soft-deleted n'étaient jamais anonymisés (écart RGPD Art. 17). Correctif : migration expand-safe **0041** (`DROP NOT NULL` + check `users_email_live_check` : seul un compte soft-deleted peut avoir un email `NULL` ; `.down.sql` qui remet un placeholder unique avant `SET NOT NULL`), lecteurs de `users.email` tolérants au `NULL`, pgTAP en `athlya_cron` + tests API.
- Changement de comportement : supprimer le compte d'un utilisateur déjà anonymisé renvoie désormais `not_found`.
- Étapes opérateur : appliquer 0041 avant ou avec le déploiement, puis `pnpm verify:role-contract` (section 1). Le backlog de comptes à anonymiser se résorbe à 100 utilisateurs par tick du cron.

### Checklist opérateur consolidée

Dédupliquée depuis les derniers commentaires des issues fermées. Noms seulement, jamais de valeurs. Ordre : staging d'abord, prod ensuite, sauf mention contraire.

#### 1. Base de données (Neon)

- [ ] Appliquer les migrations **dans l'ordre**, avant le déploiement des Workers (expand/contract) : 0031 → 0032 → 0033 → 0034 → 0035 → 0036 → 0037 → 0038 → 0039 → 0040 → **0041** (#630 ; avant ou avec le déploiement, expand-safe). Staging, puis production. → [`expand-contract-migrations.md`](../../../docs/runbooks/expand-contract-migrations.md), [`db-role-switch.md`](../../../docs/runbooks/db-role-switch.md)
- [ ] Vérifier les fonctions `SECURITY DEFINER` : `SELECT count(*) FROM pg_proc WHERE proowner = 'athlya_owner'::regrole AND proname ~ '^(auth|rgpd|notification|studio|reservation|capacity)_'` doit renvoyer 26.
- [ ] Mots de passe des rôles : `athlya_app` (y compris sur la branche Neon parente des previews), `athlya_cron`, et `ALTER ROLE athlya_billing LOGIN PASSWORD …`. → [`db-role-switch.md`](../../../docs/runbooks/db-role-switch.md), [`stripe-production.md`](../../../docs/runbooks/stripe-production.md)
- [ ] `pnpm verify:role-contract` contre staging puis production, avec les vraies URLs `athlya_app` / `athlya_cron`.

#### 2. Cutover des rôles DB + soak staging

- [ ] Staging : `DB_URL` → `athlya_app`, `CRON_DB_URL` → `athlya_cron`, `BILLING_DB_URL` → `athlya_billing` (jamais un superuser ni un rôle Console Neon, qui hérite de `BYPASSRLS`). → [`db-role-switch.md`](../../../docs/runbooks/db-role-switch.md)
- [ ] Soak staging : surveiller les `42501` et les lectures vides dans Sentry/Axiom. Le staging gate exige en plus un soak de 10 min sur le SHA avant prod (#615). → [`deploy-production.md`](../../../docs/runbooks/deploy-production.md)
- [ ] Production : même cutover, sign-off quand le soak ne montre aucune erreur RLS.

#### 3. Secrets et vars Cloudflare Workers (par Worker, par env)

Liste complète par Worker (gateway, auth, reservations, billing) dans le tableau « Secrets Worker vérifiés » de [`deploy-production.md`](../../../docs/runbooks/deploy-production.md) ; `scripts/verify-secrets.mjs` bloque le déploiement si un secret manque. Nouveautés de la session :

- [ ] `EXPORT_URL_SIGNING_KEY` (≥ 32 caractères) : **même valeur** sur le gateway (signe) et le Worker reservations (vérifie). → [`rgpd-export.md`](../../../docs/runbooks/rgpd-export.md)
- [ ] `CRON_DB_URL` (gateway), `BILLING_DB_URL` (gateway + billing).
- [ ] Stripe : `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_PRO`, `BILLING_REDIRECT_URL` (gateway + billing). → [`stripe-production.md`](../../../docs/runbooks/stripe-production.md)
- [ ] Production uniquement : `SENTRY_DSN`, `OTEL_*` sur les 4 Workers ; `CF_ACCESS_*` sur le gateway et le billing Worker (`/admin/*`). → [`cf-access-admin.md`](../../../docs/runbooks/cf-access-admin.md)
- [ ] Vars `API_PUBLIC_URL` (toutes les envs, preview incluse) et `AVATARS_PUBLIC_URL` (voir R2).
- [ ] Hyperdrive staging + production (`/health/ready` → `checks.hyperdrive.status: ok`). → [`hyperdrive-provision.md`](../../../docs/runbooks/hyperdrive-provision.md)

#### 4. Queues Cloudflare

- [ ] `wrangler queues create athlya-outbox-kick` (dev + production) et `wrangler queues create athlya-outbox-kick-staging`. `verify-secrets` bloque le déploiement tant qu'elles n'existent pas. → [`outbox-ops.md`](../../../docs/runbooks/outbox-ops.md)
- [ ] Après déploiement staging : une écriture doit logguer `outbox.kick_drain` et `outbox.drain_cycle` avec `trigger: "kick"`, et le cron doit drainer une ligne seedée.

#### 5. R2

- [ ] Buckets `athlya-exports-{env}` (privés, sans domaine public) + règle lifecycle `expire-exports` sur `exports/members/` à 3 jours. → [`rgpd-export.md`](../../../docs/runbooks/rgpd-export.md)
- [ ] Buckets `athlya-avatars-{env}` avec un accès public (domaine custom R2) pour servir les avatars.
- [ ] **Upload d'avatar en mode dégradé** : tant que `AVATARS_PUBLIC_URL` n'est pas posé, `PUT /v1/members/me/avatar` répond `503 avatar_upload_not_configured`. La var doit être posée **sur le gateway (`wrangler.toml`) et sur le Worker reservations (`wrangler.reservations.toml`)**, mêmes envs et même valeur (`worker-routing.test.ts` échoue si les deux configs divergent). → [`deploy-production.md`](../../../docs/runbooks/deploy-production.md)

#### 6. Domaines et déploiements

- [ ] DNS + domaine custom Cloudflare pour `staging.api.athlya.app` (allowlist Host). → [`deploy-production.md`](../../../docs/runbooks/deploy-production.md)
- [ ] Déployer les sub-workers auth, reservations et billing (le canary les déploie avant le gateway depuis #579). → [`canary-deploy.md`](../../../docs/runbooks/canary-deploy.md)
- [ ] Workers + domaines custom web et studio, seed des données de smoke, puis Deploy Frontend sur staging, puis production. → [`deploy-frontend.md`](../../../docs/runbooks/deploy-frontend.md)

#### 7. GitHub Actions (secrets/vars)

- [ ] Confirmer que les Actions démarrent des jobs : `node scripts/verify-ci-health.mjs --strict`. → [`ci-recovery.md`](../../../docs/runbooks/ci-recovery.md)
- [ ] Environnement `staging` — secrets : `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `MIGRATION_DB_URL_STAGING`, `STAGING_SMOKE_EMAIL`, `STAGING_SMOKE_PASSWORD`, `STAGING_SMOKE_ADMIN_EMAIL`, `STAGING_SMOKE_ADMIN_PASSWORD` (comptes dédiés seedés), optionnel `STAGING_SMOKE_TURNSTILE_TOKEN` ; vars : `WEB_URL`, `STUDIO_URL`, `API_URL`, `TURNSTILE_SITE_KEY`. Environnement `production` : mêmes vars de déploiement frontend (le release smoke prod est anonyme, sans identifiants).
- [ ] Variables de repo (inventaire `.github/workflows/ci-required-vars.yml`) : `STAGING_API_URL`, `PRODUCTION_API_URL`, `K6_STAGING_BASE_URL`, `ZAP_TARGET_URL`, `ZAP_ACTIVE_TARGET_URL`, `SYNTHETIC_TARGET_URL`, `SENTRY_ORG`, `SENTRY_PROJECT`, `NEON_PROJECT_ID`, `CLOUDFLARE_WORKERS_SUBDOMAIN`, `TF_CLOUD_ORGANIZATION`, `STAGING_SMOKE_STUDIO_SLUG` (studio seedé avec un cours à venir et une place libre). Optionnel : `CANARY_MAX_ERRORS`. → [`branch-protection.md`](../../../docs/runbooks/branch-protection.md)
- [ ] Previews : `NEON_API_KEY` + secrets `PREVIEW_*` (`PREVIEW_JWT_KID` doit commencer par `preview-`), JWKS publié avec ce kid (le deploy ne le récupère pas), puis un vrai run de PR **teardown inclus**. → [`preview-pr.md`](../../../docs/runbooks/preview-pr.md)
- [ ] ZAP : cible isolée à données synthétiques, `ZAP_TARGET_URL` + `ZAP_ACTIVE_TARGET_URL`, joindre les rapports des premiers runs qui scannent réellement. → [`zap-activation.md`](../../../docs/operations/zap-activation.md)
- [ ] **Checks CI rouges tant que l'infra staging manque** (fail closed, avec un comportement fork/Dependabot propre à chaque workflow, détaillé ci-dessous). Seul `Lint, typecheck, and tests` est un check requis par la protection de `master` (API `branches/master/protection` ; le tableau « Required status checks » de [`branch-protection.md`](../../../docs/runbooks/branch-protection.md) décrit la cible, pas la config actuelle). Les autres ne bloquent pas le merge :
  - `Staging gate` (`staging-gate.yml`, chaque PR vers `master` et chaque push sur `master` ; neutre sur les PRs de fork et les runs Dependabot) : exige, dans l'environnement `staging`, les secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `MIGRATION_DB_URL_STAGING`, `STAGING_SMOKE_EMAIL`, `STAGING_SMOKE_PASSWORD` et les vars `STAGING_API_URL`, `STAGING_SMOKE_STUDIO_SLUG`. Optionnels : `STAGING_SMOKE_TURNSTILE_TOKEN` ; l'étape k6 du gate ne tourne que si `K6_STAGING_BASE_URL` est posé (avec `K6_STAGING_AUTH_TOKEN`, `K6_STAGING_STUDIO_ID`, `K6_STAGING_CLASS_IDS`). `deploy-production.yml` exige ce check vert sur le SHA promu.
  - `ZAP baseline` (`zap-baseline.yml`, chaque PR ; ignoré sur les PRs de fork, mais pas sur les PRs Dependabot) : exige `ZAP_TARGET_URL`.
  - Tests de charge k6 (`load-test.yml`) : filtrés par chemins (`packages/reservations/**`, `packages/api/**`, `k6/**`, `.github/workflows/load-test.yml`), donc absents des PRs qui n'y touchent pas ; aucun traitement spécial fork/Dependabot. Les deux jobs exigent la var `K6_STAGING_BASE_URL`, puis :
    - `book-class load test` : secrets `K6_STAGING_AUTH_TOKENS` (CSV de JWTs, forme canonique ; `K6_STAGING_AUTH_TOKEN` singulier accepté en fallback legacy), `K6_STAGING_STUDIO_ID`, `K6_STAGING_CLASS_IDS` ;
    - `list-classes load test` : secret `K6_STAGING_AUTH_TOKEN` seulement.
  - Filtrés par chemins, sans dépendance staging : `pgTAP` (`packages/db/migrations/**`, `packages/db/tests/rls/**`), `integration-docker` (`packages/{db,members,reservations,api}/**`), axe/E2E (`apps/web/**`, `apps/studio/**`, `packages/shared/**`).

#### 8. Terraform / HCP

- [ ] Workspaces HCP `athlya-staging` et `athlya-production` en exécution « Local » ; `TF_TOKEN_app_terraform_io` + `TF_CLOUD_ORGANIZATION`. → [`terraform-ops.md`](../../../docs/runbooks/terraform-ops.md)
- [ ] `gh workflow run terraform.yml -f environment=staging -f action=plan` : relire tout le plan, aucun `must be replaced` ni `destroy` attendu (sinon `state rm` + `import` v5 du runbook). Importer d'abord les rulesets WAF existants.
- [ ] Apply staging, re-plan → aucun changement ; idem production.
- [ ] Var `CLOUDFLARE_ZONE_PLAN` sur chaque environnement GitHub (défaut `pro`) ; variable Terraform `sentry_alert_team_id` ; décider d'activer ou non Bot Fight Mode ; prouver que les requêtes bloquées par le WAF n'atteignent jamais le Worker.

#### 9. Observabilité (Sentry / Axiom / Checkly)

- [ ] Sentry : `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_DSN` ; upload des source maps obligatoire en prod. → [`sentry-sourcemaps.md`](../../../docs/runbooks/sentry-sourcemaps.md)
- [ ] Axiom : moniteurs SLO A1–A5 et A16 via Terraform (`axiom-monitors.tf`, appliqués avec la section 8) ; moniteurs manuels A6–A15, A17, A18 (dont A14) dans l'UI Axiom. → [`axiom-alerts-provision.md`](../../../docs/runbooks/axiom-alerts-provision.md)
- [ ] Alertes outbox : `outbox.drain_cycle` (cycle, chevauchement), âge et taille du backlog, lag de lane > 2 min, `outbox.kick_failed`, `outbox.kick_drain_failed`. → [`outbox-ops.md`](../../../docs/runbooks/outbox-ops.md)
- [ ] Fire test staging : déclencher une erreur, vérifier que l'alerte Sentry et les moniteurs Axiom se déclenchent, consigner la preuve.
- [ ] Checkly CK3/CK4 (`SYNTHETIC_TARGET_URL`), CK4 vert pendant 24 h. → [`synthetic-monitoring.md`](../../../docs/operations/synthetic-monitoring.md)
- [ ] Alerte quota QStash. → [`qstash-quota.md`](../../../docs/runbooks/qstash-quota.md)

#### 10. Stripe

- [ ] Dashboard : produit, prix, endpoints webhook (staging + production). → [`stripe-production.md`](../../../docs/runbooks/stripe-production.md)
- [ ] Secrets Workers (section 3), migrations 0032–0036 appliquées (section 1).
- [ ] E2E en mode test sur staging (phase 4 du runbook).

#### 11. Preuves de validation (staging puis prod)

- [ ] Staging gate vert sur un SHA de `master`, puis un déploiement prod accepté par le check « même SHA ». → [`deploy-production.md`](../../../docs/runbooks/deploy-production.md)
- [ ] Canary : un release qui promeut à 100 % et un release cassé qui rollback. → [`canary-deploy.md`](../../../docs/runbooks/canary-deploy.md), [`automatic-rollback.md`](../../../docs/runbooks/automatic-rollback.md)
- [ ] Outbox : benchmark backlog 10k avec trafic réel (latence d'envoi, erreurs de limite de subrequests), événement RGPD mis en queue en < 30 s pendant le burst, exercice de panne de queue. → [`outbox-ops.md`](../../../docs/runbooks/outbox-ops.md)
- [ ] Bulkheads : test de charge montrant qu'un Worker saturé ne dégrade pas le p99 des autres.
- [ ] Export RGPD : E2E staging avec vrais Postgres, Queue et R2 (factures vides tant que la facturation ne persiste rien). → [`rgpd-export.md`](../../../docs/runbooks/rgpd-export.md)
- [ ] Smoke E2E staging (login → réservation → annulation) en exit 0, puis cocher l'item E2E de la [launch checklist](../../../docs/operations/v1.0.0-launch-checklist.md) et y joindre toutes les preuves.

---

## Hardening phase — livrée ✅

Insérée entre Epic 8 et Epic 10. Règle les 4 vrais bloquants identifiés dans `critique.md`.

- ✅ **H1 Audit log anonymisation via SECURITY DEFINER** — résout la contradiction Req 5.3 / Req 22.2. 13 tests pgTAP.
- ✅ **H2 Drain DLQ + admin endpoints** — `/admin/dlq/{stats,replay,discard}`. 23 tests.
- ✅ **H3 Circuit breaker per-isolate documenté** — JSDoc + test `isolate independence`.
- ✅ **H4 Middleware chain integration tests** — 16 tests in-process via `app.request()`.
- ✅ **H5 Cycle `@athlya/api` ↔ `@athlya/auth` cassé** — nouveau package `@athlya/ratelimit`.
- ✅ **H6 Baselime → Axiom** — 11 fichiers mis à jour.
- ✅ **H7 Rollback migrations** — `.down.sql` pour 0000/0001/0002/0003.
- ✅ **H8 README opérationnel** — TCO réaliste, limites v0.1 assumées.

---

## Épics terminés

### Epic 1 — Bootstrap monorepo & fondations (6/6) ✅
### Epic 2 — Base de données, migrations, RLS (7/7) ✅
### Epic 3 — Authentification (7/7) ✅
### Epic 4 — Rate limiter & idempotency (3/3) ✅
### Epic 5 — Members & RGPD (7/7) ✅
### Epic 6 — Reservations domain (11/11) ✅
### Epic 8 — API Gateway Hono (12/12) ✅
### Epic 9 — Event bus, outbox, notifications (7/7) ✅
### Epic 13 — CI/CD & observability (5/5) ✅
### Epic 15 — Multi-tenant rollout (3/3) ✅ ⏫ NOUVEAU
- 15.1 Tenant resolver (subdomain + path + reserved set + custom apex)
- **15.2 `studio.brand_color` → CSS variables + RN theme** — `packages/shared/src/theming/` avec `parseBrandColor`, `deriveBrandColorVariables` (contraste WCAG 2.2 relative luminance, pairing noir/blanc au crossover 0.179), `buildBrandColorCss` pour web/studio (inline `<style>` SSR), `buildRNBrandTheme` pour Expo. 27 tests dont property test numRuns 50.
- **15.3 Integration test multi-tenant isolation** — `multi-tenant-isolation.integration.test.ts` sur 9 cas couvrant 6 endpoints. Cross-tenant = 404 `not_found`, pas 403 (pas de leak d'existence). `seedTwoStudios` helper ajouté à `integration-helpers.ts`.
### Epic 16 — Billing Stripe (3/3) ✅ ⏫ NOUVEAU
- 16.1 Checkout session Stripe Connect avec DI port (pas de SDK runtime)
- **16.2 Stripe webhook handler + HMAC-SHA256 Web Crypto** — `packages/billing/src/webhook.ts`. `verifyStripeSignature` pur (parse `t=,v1=`, tolerance 300s symétrique, HMAC constant-time via `crypto.subtle.verify`, multi-`v1=` pour key rotation). `handleStripeWebhook` dispatch `checkout.session.completed`/`customer.subscription.created` → `billing.subscription.started`, `invoice.payment_failed` → `billing.subscription.failed`. Signature failure → audit atomique via `withTransaction`, `signatureHeader: '[REDACTED]'`, erreurs propagent (pas de swallow).
- **16.3 Unit tests signature verification** — 21 tests : 12 `verifyStripeSignature` (happy path, malformed header, missing t/v1, stale/future timestamp, wrong secret, tampered payload, multi-v1 rotation, invalid JSON, custom tolerance/clock), 4 happy path, 5 failure paths dont atomicité audit + redaction guard + error propagation.
### Epic 17 — Waitlist notifications (1/1) ✅ ⏫ NOUVEAU
- 17.1 Handler `reservation.promoted` dans Notifications consumer
### Epic 14 — Checkpoint v0.1 MVP (1/1) ✅ ⏫ NOUVEAU
- 14. `profile-edit.spec.ts` (web) + `class-management.spec.ts` (studio) hermétiques. Workflow `axe.yml` étendu avec job `studio-e2e-flows`. `profile-edit` : login form → `PATCH /v1/members/me` → bannière "Profil mis à jour". `class-management` : boot refresh → dialog create → `POST /v1/classes` → titre dans table. LIFO route override pour stateful GET post-creation.

### Epic 19 — i18n coverage & Accept-Language (2/2) ✅

### Epic 10 — Web member app (8/8) ✅ ⏫ NOUVEAU
- 10.1 Next.js 16.2.6 + React 19.2.0 + Tailwind 4.3.0 scaffold. CSP per-request via `src/proxy.ts` (Next 16 renomme `middleware.ts` → `proxy.ts`, export nommé `proxy`). Static security headers dans `next.config.ts`. 10 tests (3 nonce + 7 CSP).
- 10.2 Auth flows `/register` + `/login`, `TurnstileWidget`, token store in-memory, `AuthContext`, API client avec 401→refresh→retry, 4 route handlers `/api/auth/{register,login,refresh,logout}` avec refresh cookie httpOnly Secure SameSite=Lax. Access token JAMAIS dans localStorage. +23 tests.
- 10.3 `/classes` avec `ClassesList` umbrella + `ClassCard`. Fetch `GET /v1/classes?from=&to=` (fenêtre 14 jours), optimistic decrement sur book, `Idempotency-Key` par clic, mapping 201/202/409/422/5xx. +10 tests.
- 10.4 `/me` profile + consents : `ProfileSection` umbrella, `ProfileForm` 80-char maxLength counter, `ConsentsForm`, `RequireAuth` guard, `newIdempotencyKey()`. +11 tests.
- 10.5 RGPD export + delete : `/me/export` avec `ExportPanel` (POST `/v1/members/me/export` → jobId), `/me/delete` avec `DeletePanel` modal (mot de confirmation i18n FR `SUPPRIMER` / EN `DELETE`, DELETE `/v1/auth/me` → clear token → logout → redirect `/`). +9 tests.
- 10.6 i18n routing : `createTranslator(locale)`, `getLocale()`, `useLocale()`, `<LocaleProvider>`, `<LocaleSwitcher>`. Proxy étendu avec détection locale (cookie → Accept-Language → 'fr' fallback). Bundle FR/EN `web.*`. +11 tests.
- 10.7 `@axe-core/playwright` + Lighthouse CI. `apps/web/e2e/axe.spec.ts` (7 pages WCAG 2.2 AA), fixture `e2e/fixtures/auth.ts`, `scripts/lighthouse-check.js`, workflow `.github/workflows/axe.yml`. Pas de régression unit tests.
- 10.8 Playwright E2E happy path register → book → cancel : `e2e/flows/register-book-cancel.spec.ts` avec route stubs `page.route()`, Turnstile bypass posture, workflow `axe.yml` étendu avec job `e2e-flows` parallèle. Cancel driven via `page.evaluate(fetch DELETE)` car pas encore de bouton cancel en UI (à remplacer par `getByRole('button')` le jour où la feature landera — pas de scaffolding prématuré).

---

## Épics partiels

### Epic 7 — Checkpoint domain (1/1) ✅
- 7. Validé — `pnpm -r test` gate vert (exit 0), cohérent avec `tasks.md` (case cochée). Toutes les suites domaine passent.

### Epic 18 — Apple Health (0/1)
- 18.1 HealthKit read — bloqué par Epic 11 (mobile Expo).

### Epic 22 — Progression graphs (1/2, #639)
- 22.1 ✅ Agrégateur `packages/members/src/progression.ts` : fonction pure `computeProgression` (volume = reps × charge, 1RM Epley `w × (1 + r/30)` sur les séries de 1 à 12 reps, fréquence par semaine ISO complétée par des zéros, lignes revalidées avec `WorkoutSessionSchema`), tests unitaires + propriétés fast-check. Lecture RLS (`withTenantHttp`, policy `workout_sessions_read_own`) sur le handle routé par région (réplica EU, CN.8.3). Route `GET /v1/me/progression?window=30|90|365` sur le Worker bulkhead reservations (+ gateway), ETag + `Cache-Control: private, max-age=60`, limiter `progression-read` fail-closed.
- 22.2 🟡 Web livré (`/me/progression`, SVG maison sans casser la CSP, accents de marque encre `#0A0A0A` / volt `#D7FF3A` (#637), focus clavier par flèches, tables de données pour lecteurs d'écran, clés FR/EN, sweep axe). Mobile restant (PR séparée, même endpoint).

---

## Non démarré (~46 tâches)

### Epic 11 — Mobile Expo (1 tâche restante : 11.9, bloquée côté API)

Foundation delivered in #642 (issue #638): 11.1–11.7, 11.12 (P5) and 11.13 on Expo SDK 58, plus the BR.4 icon and splash. See `docs/mobile/README.md`.

Écrans membres livrés pour #647 : connexion / inscription, réservation de cours avec mise à jour optimiste (11.8) et « Mes réservations » (annulation), journal de séance (11.10), paramètres avec export / suppression RGPD (11.11), déverrouillage biométrique, déconnexion et vue « modifications refusées » (DLQ), plus la séance du jour du programme sur l'accueil (24.4). Toutes les écritures passent par `features/writes.ts` : envoi direct avec une `Idempotency-Key` UUID v4, mise en file avec la même clé sur `NetworkError`, hors ligne, ou quand des écritures plus anciennes de l'utilisateur attendent encore (ordre FIFO). La logique des écrans est testée en Node (vitest).

Restent ouverts :

- 11.9 (QR check-in) : pas de route d'émission de token et `/v1/checkins` non monté en production (#648, suite de #302). `POST /v1/sessions` n'est pas routé non plus : les séances enregistrées depuis l'app arrivent dans « modifications refusées » tant que l'adaptateur n'est pas livré.
- Connexion depuis l'app en staging / production : `login` et `register` exigent un token Turnstile que l'app native ne sait pas produire (`403 bot_challenge_failed`), #649.
### Epic 12 — Admin studio app (4 tâches restantes — 12.2 et 12.3 livrées)
### Epic 20 — Checkpoint v0.2
### Epics v0.3 (Epic 21–25 — 22.1 livrée, 22.2 web livrée, Epic 24 complet : 24.1–24.3 #640/#643, 24.4 mobile #647)

---

## État des tests

Suite complète au 2026-10-12 après la mise à jour de stack (Node 24, pnpm 11, TS 6, Vitest 5) — nombres identiques à la baseline pré-upgrade, zéro régression. Docker absent du sandbox : suites Testcontainers skippées.

| Package | Tests | Notes |
|---|---|---|
| `@athlya/shared` | 146/146 | dont PBT round-trip (fast-check 4) |
| `@athlya/db` | 104/104 | PGlite P4/P7 always-run |
| `@athlya/auth` | 139/139 | — |
| `@athlya/ratelimit` | 7/7 | — |
| `@athlya/api` | 823/824 (+1 todo) | l'échec = `turnstile.test.ts` round-trip réseau réel vers `challenges.cloudflare.com` (bloqué par le proxy sandbox, passe en CI) |
| `@athlya/members` | 75/75 | — |
| `@athlya/reservations` | 139/139 (+ 2 Docker-gated) | dont PBT P1, P2, P3 |
| `@athlya/notifications` | 58/58 | — |
| `@athlya/billing` | 32/32 | — |
| `@athlya/web` | 101/101 | jsdom 30 ; E2E Playwright (axe + flows) en CI uniquement |

**Total : ~1 625 tests exécutés.** Playwright E2E (axe + flows) s'exécute dans `.github/workflows/axe.yml` avec 4 jobs parallèles : `a11y`, `e2e-flows`, `studio-a11y`, `studio-e2e-flows`.

## PBT validées (10/10)

P1 capacity, P2 idempotence, P3 state-machine, P4 RGPD cascade, P6 JWT non-forge/replay, P7 tenant isolation, P8 ratelimit (déplacée dans @athlya/ratelimit), Round-trip serialization, property test circuit breaker H3 "open state short-circuits fn", **property test brand-color 15.2** (every valid hex yields well-formed tokens), **P1 booking capacity** (`booking.property.test.ts` — confirmedCount ≤ capacity, no duplicates, waitlist ordering; unblocked by #481 fixing undici/Node-20 compat + Date ISO serialization in outbox).
**P5 FIFO + idempotent offline drain** (11.12) : `apps/mobile/tests/properties/offline.property.test.ts`, delivered in #642.

## Prochaine priorité

Epic 14 fermé — Checkpoint v0.1 MVP livré. Reste deux gros chantiers front :

- **Epic 11 — Mobile Expo** (reste 11.9, bloquée par l'API #648 ; connexion mobile derrière Turnstile #649 ; fondation #642 et écrans #647 livrés)
- **Epic 12 — Admin studio app** (4 tâches restantes)

## Conventions maintenues

- pnpm 11 workspaces, Turborepo 2.x, Node 24 LTS, TS 6.0, ESLint 9 flat (ESLint 10 / TS 7 bloqués par l'écosystème lint — voir `docs/ACTION-ITEMS.md` U1/U2)
- Framework-free avec ports injectés ; adapters Drizzle/Stripe/Resend/Expo en prod seulement
- Hono peerDependency de `@athlya/api` — middleware duck-typés
- Tests Testcontainers : `describe.skipIf(!dockerReady)` ; infra-probe test toujours enregistré
- `fast-check@^4.10.2` (Vitest 5), numRuns 20–200, seeds hex fixes
- Zod `.strict()` partout sauf `AuditLog.metadata`
- Pas de hard-coded strings user-facing hors `@athlya/shared/i18n`
- `AthlyaVariables` étendu incrémentalement : 8.1 (traceId/logger/startedAt), 8.2 (authClaims?), 8.6 (span?)
- `AthlyaBindings` étendu : 8.6 (OTEL_EXPORTER_*), H2 (EVENTS_DLQ), 8.9 (TURNSTILE_SECRET)
- Secret-leak guard sur la branche 500 du mapper Problem Details : `err.message` JAMAIS dans le body (testé avec `hunter2`)
- Append-only audit_log : RLS USING(false) + trigger + SECURITY DEFINER function unique chemin (H1)
- 3 rôles Postgres : `athlya_owner` (owner), `athlya_cron` (worker RGPD), `athlya_app` (runtime) — migration 0003 (H1)
- Chaque migration a un `.down.sql` FK-safe reverse order (H7)
- Circuit breaker per-isolate assumé explicitement (H3)
- DLQ drain manuel via `/admin/dlq/*` + tracker Redis (H2)
- Exporter OTel agnostique : `OTEL_EXPORTER_OTLP_ENDPOINT` configurable, default Axiom (H6)
- Stripe signature verification hand-rolled via Web Crypto — pas de SDK Stripe 400 KB sur Workers (16.2)
- Cross-tenant reads : 404 systématique, jamais 403 (Req 13.5 — pas de leak d'existence, validé par 15.3)


---

## Niveau 2 — Live wiring (sessions Vagues 6 → 11)

Livré hors-spec, workflow "brancher les secrets live + adapters Drizzle/Upstash pour un flow end-to-end en local dev". Détails dans `docs/modifications/modifications.md`.

### Vague 6 — Fix I/O isolation Cloudflare Workers ✅
- `packages/api/src/adapters/auth-deps.ts` : retrait du cache module-scope (dbCache, redisCache, serviceCache). Rebuild Drizzle + Upstash clients par requête. Seul `jwtCache` (CryptoKey, pas I/O) conservé.
- Débloque le 2ème login consécutif qui crashait avec `Cannot perform I/O on behalf of a different request`.

### Vague 7 — UX auth (Turnstile + AuthError + diagnostics) ✅
- `TurnstileWidget` expose `reset()` via `useImperativeHandle`; callbacks `error-callback` / `expired-callback` / `timeout-callback` avec `refresh-expired: 'auto'`.
- `problem-details.ts` : branche duck-typed `AuthError` → 401/404/422/429 per `code`. Plus de 500 sur `invalid_credentials`.
- Scripts `check-password.mjs` + `reset-password.mjs` dans `packages/db/scripts/`.

### Vague 8 — Adapters Epic 5 Members ✅
- `adapters/members-repo-drizzle.ts` (getProfile, updateProfile, listByStudio pagination cursor-based)
- `adapters/members-consents-repo-drizzle.ts` (jsonb inline)
- `adapters/members-audit-writer-drizzle.ts` (append-only)
- `adapters/members-export-job-store-drizzle.ts` (state machine + partial index dedup)
- `adapters/members-deps.ts` factory.
- Débloque `GET /me`, `PATCH /me`, `PATCH /me/consents`, `POST /me/export`, `GET /members` (admin/coach).
- `apps/web/src/app/HomeActions.tsx` — landing auth-aware (signed-out: register/login ; signed-in: classes/me/logout).

### Vague 9 — Adapters Epic 6 Classes (lecture) + stubs writes ✅
- `adapters/classes-repo-drizzle.ts` (list/create/update factories).
- `adapters/reservations-list-drizzle.ts` — `listMyReservations` direct JOIN (pas de service).
- `adapters/reservations-deps.ts` factory.
- Subpaths `@athlya/reservations/{create,update}` ajoutés.
- Débloque `GET /v1/classes`, `POST /v1/classes`, `PATCH /v1/classes/:id`, `GET /v1/reservations/me`.
- **⏳ Non livré (slice future)** : `POST /v1/reservations` (bookClass) + `DELETE /v1/reservations/:id` (cancelReservation) — nécessite l'adapter transactionnel (SELECT FOR UPDATE SKIP LOCKED, FIFO waitlist promotion, outbox insert, Redis DECR/INCR compensating).

### Vague 10 — Micro-fixes UX ✅
- `packages/db/scripts/seed-classes.mjs` (idempotent + Redis counter seed).
- `.env.local.example` commenté 4 sections.
- `aria-busy` sur LoginForm + RegisterForm.

### Vague 11 — Ops / docs / error boundaries ✅
- Root `pnpm seed:all` (migrate + seed-dev + seed-classes en un cmd).
- `apps/web/src/lib/api/client.ts` — branche 429 avec `retryAfterSec` parsé.
- `apps/web/src/app/me/error.tsx` — error boundary segment.
- `apps/web/src/app/classes/ClassCard.tsx` — Intl.DateTimeFormat locale-aware.
- `docs/dev-setup.md` + `docs/runbooks/login-fails.md`.

### Vague 12 — Photo de profil file picker ✅
- `ProfileForm.tsx` : `<input type="url">` → `<input type="file">` avec preview, cap 256 KiB, conversion `data:` URL via FileReader.
- +4 clés i18n FR/EN.

---

## Restant pour Niveau 2 complet

✅ **Niveau 2 complet** — tous les 13 items livrés.

---

**Tests cumulés session Vagues 6-11 : 601/601 verts** (382 API + 137 shared + 82 web), zero régression par rapport au baseline pre-Niveau-2.


### Vague 13 — Adapter transactionnel book/cancel (N2.5) ✅
- `adapters/reservations-write-drizzle.ts` — `createDrizzleBookingRepo`, `createDrizzleCancelRepo`, `createBookingEventPublisher`.
- `BookingRepo` : `findClass` (pre-flight), `withTransaction` (BEGIN/COMMIT/ROLLBACK), `findExistingConfirmedOrWaitlistReservation`, `insertReservation` (23505 → `UniqueViolationError`), `insertOutbox` (commit-together), `countWaitlistAhead`.
- `CancelRepo` : `withTransaction`, `findReservationForUpdate` (`.for('update')`), `findClassForUpdate` (`.for('update')`), `updateReservationStatus` (stamps `cancelled_at`), `findOldestWaitlistForClass` (`.for('update', { skipLocked: true })` pour éviter les deadlocks entre cancels concurrents), `insertOutbox`.
- `createBookingEventPublisher` : builds `reservation.created` + `reservation.waitlisted` envelopes avec UUID + `occurredAt`.
- `reservations-deps.ts` : remplacement des stubs `not_implemented` par `svcBookClass` + `svcCancelReservation`, avec mapping des codes service (`ok`/`waitlisted`/`already_booked`/`class_in_past`/`class_not_found`) vers les `BookingOutcome` du router.
- Débloque `POST /v1/reservations` + `DELETE /v1/reservations/:reservationId`. Algorithmes 1 + 2 actifs end-to-end.
- 382/382 tests API verts, zero régression.


### Slice 12.A — Studio admin app scaffolding ✅
- Nouveau workspace `apps/studio` (Next.js 16 + React 19 + Tailwind 4 + same CSP envelope as `apps/web`).
- Files créés:
  - Config: `package.json` (port dev 3001), `next.config.ts`, `tsconfig.json`, `eslint.config.js`, `postcss.config.mjs`, `next-env.d.ts`, `.gitignore`, `.env.local.example`.
  - `src/proxy.ts` — Edge proxy avec nonce CSP + locale negotiation (mirroir web).
  - `src/lib/{nonce,csp,env,idempotency}.ts` — utils dupliqués depuis web pour rester monorepo-clean (pas de cross-app runtime import).
  - `src/lib/i18n/{negotiate,getLocale,t,LocaleContext}.{ts,tsx}` — locale chain.
  - `src/lib/auth/{token-store,cookies,AuthContext}.{ts,tsx}` — auth en mémoire + refresh cookie scopé `athlya.refresh.studio` (distinct du web `athlya.refresh` pour permettre un user de tenir admin + member sessions séparément).
  - `src/lib/api/client.ts` — typed HTTP client (copie web).
  - `src/components/{LocaleSwitcher,RequireAdmin}.tsx` — admin gate redirige `member`/`coach` vers `/forbidden`.
  - `src/app/api/auth/{login,logout,refresh}/route.ts` — 3 route handlers Next proxy vers `/v1/auth/*`.
  - `src/app/{layout,page,not-found,error,loading}.tsx` — shell racine + 404/error/loading.
  - `src/app/login/{page,LoginForm}.tsx` — form sans widget Turnstile (TODO 12.B).
  - `src/app/dashboard/{layout,page}.tsx` — admin-protected layout + landing avec 4 cards (Classes, Members, Branding, Billing).
  - `src/app/forbidden/{page,ForbiddenActions}.tsx` — landing pour role non-admin.
  - `src/app/globals.css` + `src/styles/tokens.css` — Tailwind 4 + design tokens.
- I18n: nouveau namespace `studio.*` (19 keys × 2 locales) mirroir FR/EN. 137/137 tests `@athlya/shared` verts (parité conservée).
- Tests TS: 0 diagnostics sur les 14 fichiers créés.
- **Restant Slice 12** :
  - 12.B Classes CRUD (calendrier admin) + port du widget Turnstile dans `LoginForm`
  - 12.C Members list + Branding settings (couleur, logo, edit `studio.brand_color`)
  - 12.D Billing dashboard (Stripe Checkout, factures, statut paiement)


### Slice 12.B — Studio admin Classes CRUD ✅
- Files créés (5):
  - `apps/studio/src/lib/api/buildClient.ts` — hook factory `useApiClient(getToken)` avec `onRefresh` qui POST `/api/auth/refresh` + clear token sur échec.
  - `apps/studio/src/app/dashboard/classes/page.tsx` — server entry.
  - `apps/studio/src/app/dashboard/classes/loading.tsx` — Suspense fallback.
  - `apps/studio/src/app/dashboard/classes/ClassesAdminList.tsx` — list + range pickers + bouton Create + table-grid avec capacité Redis live.
  - `apps/studio/src/app/dashboard/classes/ClassFormDialog.tsx` — modal create/edit, schema validation client (`CreateClassRequestSchema` + `UpdateClassRequestSchema`), idempotency-key par submit, gestion 409 `version_conflict` (refetch list + banner).
- I18n: 21 clés `studio.classes.*` × 2 locales mirrored (range, row, fields, dialog, errors). 137/137 tests `@athlya/shared` verts.
- Tests TS: 0 diagnostics sur les 5 fichiers.
- **Restant Slice 12** :
  - 12.C Members list + Branding settings (`studio.brand_color` editor)
  - 12.D Billing dashboard (Stripe Checkout, factures, statut)


### Slice 12.C — Studio admin Members + Branding ✅
- Files créés (4):
  - `apps/studio/src/app/dashboard/members/page.tsx` — server entry.
  - `apps/studio/src/app/dashboard/members/MembersAdminList.tsx` — cursor-paginated list (limit 20), bouton "Charger plus", role badge, avatar fallback initiale, format date locale.
  - `apps/studio/src/app/dashboard/branding/page.tsx` — server entry, preview read-only.
  - `apps/studio/src/app/dashboard/branding/BrandingPreview.tsx` — swatch + WCAG contrast pairing inline + sample button.
- I18n: 16 clés × 2 locales (`studio.members.*` + `studio.branding.*`).
- 137/137 tests `@athlya/shared` verts.
- **Restant Epic 12** :
  - 12.D Billing dashboard (Stripe Checkout, factures, statut paiement)
  - **Backlog dédié** : `/v1/studios/me` GET + PATCH endpoint + brand color editor live (sortie de scope 12.C — l'API n'expose pas encore de studio CRUD).


### Slice 12.D — Studio admin Billing dashboard ✅
- File créé (1):
  - `apps/studio/src/app/dashboard/billing/page.tsx` — placeholder Free/Pro plans + invoices section + bouton Checkout disabled.
- I18n: 12 clés `studio.billing.*` × 2 locales.
- 137/137 tests `@athlya/shared` verts.
- **Backlog** : endpoint `/v1/billing/checkout` côté API + brancher le bouton sur Stripe Checkout via `@athlya/billing` (déjà livré côté package via Epic 16).

### Fix runtime — Slice 12.D-bis
- `packages/api/src/adapters/reservations-deps.ts` : `BookingCounter` adapter avec `decrRemaining`/`incrRemaining` qui forwarde vers `RemainingCounter.decr`/`.incr`. Le `bookClass` branch utilisait directement `counter` (RemainingCounter shape), mais le service `bookClass` attend `BookingCounter` (decr/incr*Remaining). Cancel branch faisait déjà le mapping, book branch non. Fix une-ligne.

### CN.7.2 — Preview environments per PR ✅

- **`.github/workflows/preview.yml`** : workflow complet `deploy` + `teardown`.
  - `deploy` (opened/synchronize/reopened) : crée une Neon branch `preview-pr-{N}` via API → injecte `DB_URL` + secrets staging (Redis, JWT, Turnstile) via `wrangler secret put --env preview` → déploie avec `wrangler versions upload --env preview` → poste/met à jour un commentaire PR avec l'URL preview.
  - `teardown` (closed) : supprime la Neon branch via API. Nettoyage idempotent (branch introuvable = no-op).
  - Idempotent sur synchronize : si la branch Neon existe déjà (409), récupère l'URI existante.
  - `concurrency` group par PR : les commits successifs annulent le deploy en cours pour ne servir que le dernier.
- **`packages/api/wrangler.toml`** : ajout de `[env.preview]` — partage les queues/R2 staging, `DB_URL` isolé par PR.
- **`docs/runbooks/preview-pr.md`** : runbook complet (setup secrets/variables GitHub, provisionnement R2/queues, flow, limitations connues, teardown manuel).
- CN.7.2 marquée `[x]` dans `tasks.md`.

### Tâches 12.4, 12.5, 12.6 — Check-in kiosk, Audit log, axe-core a11y ✅

**12.4 — Check-in kiosk** (`apps/studio/src/app/dashboard/checkin/`):
- `CheckinKiosk.tsx` : client component, BarcodeDetector + getUserMedia, state machine discriminée (`scanning → submitting → success | error`), countdown 5 s auto-reset, fallback manuel si caméra indisponible.
- POST `/v1/checkins` avec header `Idempotency-Key` (UUID v4 par scan).
- i18n : namespace `studio.checkin.*` en EN + FR (11 clés dont erreurs métier).

**12.5 — Audit log viewer** (`apps/studio/src/app/dashboard/audit/`):
- `AuditLogList.tsx` : client component, cursor pagination GET `/v1/audit?limit=20&cursor=<id>`, skeletons + état vide + "Load more".
- `packages/api/src/routes/audit.ts` : router admin-only, `requireRole('admin')`, zValidator query, cursor pagination BIGSERIAL.
- `packages/api/src/adapters/audit-deps.ts` : stub adapter (impl DB à câbler).
- Wiring complet dans `routes/index.ts` (DomainDeps + lazy + default).
- Schemas Zod dans `@athlya/shared` : `AuditListItemSchema`, `AuditListResponseSchema`.
- OpenAPI spec + test `openapi-spec.test.ts` mis à jour (25 routes).

**12.6 — axe-core a11y sweep studio**:
- `apps/studio/e2e/playwright.config.ts` : port 3001, reuseExistingServer local.
- `apps/studio/e2e/fixtures/auth.ts` : stub POST `/api/auth/refresh` → admin user + stubs tous les endpoints API (classes, members, studios, audit, billing, checkins).
- `apps/studio/e2e/axe.spec.ts` : sweep WCAG 2.2 AA sur `/login` + 7 pages admin.
- `.github/workflows/axe.yml` : job `studio-a11y` parallèle.
- Tasks 12.4, 12.5, 12.6 marquées `[x]` dans `tasks.md`.

### Fix i18n — tâches 12.2 / 12.3 ✅
- `packages/shared/src/i18n/en.json` + `fr.json` : ajout de la clé `studio.members.joinedAt` ("Joined" / "Inscrit le") manquante.
- `apps/studio/src/app/dashboard/members/MembersAdminList.tsx` : remplacement du texte hardcodé `"Inscrit le"` par `{t('studio.members.joinedAt')}`.
- Tasks 12.2 et 12.3 marquées `[x]` dans `tasks.md`.

### Slice 12.B-bis — Studio Turnstile widget ports ✅

- Files créés (3):
  - `apps/studio/src/types/turnstile.d.ts` — global ambient declaration (mirror web).
  - `apps/studio/src/components/TurnstileWidget.tsx` — widget complet (refresh-expired auto, error/expired/timeout callbacks, reset handle).
  - `apps/studio/.env.local` — créé depuis l'example avec `NEXT_PUBLIC_API_URL=http://127.0.0.1:8787` + `NEXT_PUBLIC_TURNSTILE_SITE_KEY=0x4AAAAAADMvm1kHYBnhzDkU`.
- LoginForm patché pour wirer le widget avec consume-token-before-fetch + reset après échec + button disabled tant que pas de token frais.
- Page login pass `nonce` depuis `headers().get('x-nonce')`.


### N2.13 — R2 avatar upload ✅ (PR #59)
- `packages/api/src/adapters/avatar-upload-store-r2.ts` : adapter R2-backed, stable key `avatars/{userId}/avatar` (sans extension — `httpMetadata.contentType` préserve le MIME), `AvatarUploadNotConfiguredError` (mode dégradé 503 si `AVATARS_BUCKET` ou `AVATARS_PUBLIC_URL` absent), guard `publicBaseUrl` avant le `bucket.put` (pas d'objet orphelin), cap 5 MiB.
- `packages/api/src/routes/members.ts` : `PUT /v1/members/me/avatar` — Content-Type guard (415), Content-Length pre-check (413 avant lecture ArrayBuffer), body size check (413), empty body guard (400), mapping `AvatarUploadNotConfiguredError` → 503.
- `packages/api/src/adapters/members-deps.ts` : méthode `uploadAvatar` — `createR2AvatarUploadStore` + `store.putAvatar` + `svcUpdateProfile({ avatarUrl })` en séquence.
- `packages/api/src/worker.ts` : bypass body limit global 256 KiB pour `PUT /v1/members/me/avatar` ; CORS `allowMethods` étendu avec `'PUT'`.
- `packages/api/src/__tests__/routes/members-avatar.test.ts` : 6 tests unitaires (401, 415, 413, 400, 503, 200).
- Niveau 2 désormais **complet à 13/13**.

---

## Backend Hardening — plan défini, slices à exécuter

Plan complet écrit dans `tasks.md` § "Backend Hardening Plan (post-v0.2)". 10 epics B1 → B10, 47 sous-tâches.

**Cibles transverses** :
- Sécurité : RLS active partout (rôle dédié non-bypass), audit anonymisation prod, anomaly detection auth.
- Performance : driver Neon HTTP (-50/100ms par request), HTTP cache + ETag, indexes audit.
- Scalabilité : rate limiting étendu mutations, idempotency audit, per-user concurrency.
- Propreté : factoriser deps factories, helpers DB partagés, dead code OAuth retiré.
- Production-ready : outbox drain documenté, DLQ retry policy, métriques + alertes SLO.

**Priorisation suggérée** (ROI/risque, voir détail tasks.md) :

| # | Epic | Pourquoi en premier |
|---|------|---------------------|
| 1 | B1 — Neon HTTP driver | Bloque tout le reste, gain perf immédiat |
| 2 | B2 — RLS hardening | Sécurité critique avant prod |
| 3 | B7 — Observability | Savoir avant de durcir |
| 4 | B5 — Perf wins | Quick wins après B1 |
| 5 | B4 — Rate limiting | Defense-in-depth |
| 6 | B8 — Code cleanup | Prépare futures slices |
| 7 | B6 — Outbox reliability | Production-ready event bus |
| 8 | B3 — Auth polish | Déjà solide, polish |
| 9 | B10 — Migration 0003 | RGPD compliance prod |
| 10 | B9 — Endpoints API | Slice produit indépendante |

**Slices restantes côté produit** (hors hardening) :
- `/v1/studios/me` (B9.1, B9.2) — débloque BrandingPreview editor
- `/v1/billing/*` (B9.3-5) — débloque Stripe Checkout studio
- Epic 11 mobile (12 sous-tâches) — Expo SDK 55 scaffolding
- Epic 14 v0.3 — AI coach, BLE FTMS, programs

L'app fonctionne end-to-end sur web + studio en local dev. Prochain chantier recommandé : **B1 driver Neon HTTP** (gain perf immédiat, débloque B2/B5).