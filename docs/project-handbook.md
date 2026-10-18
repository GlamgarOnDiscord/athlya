# Athlya : manuel du projet

> Détails opérationnels sortis du [README](../README.md) : état d'avancement, tests, coûts, limites assumées, RGPD, incidents, fournisseurs et conventions.

## État du projet

L'avancement détaillé, tâche par tâche et epic par epic, est tenu à jour dans [`PROGRESS.md`](../.kiro/specs/athlya-platform/PROGRESS.md) et [`tasks.md`](../.kiro/specs/athlya-platform/tasks.md) ; l'historique des versions dans le [CHANGELOG](../CHANGELOG.md). Cette page ne recopie pas ces compteurs pour éviter qu'ils divergent.

**Hardening phase livrée** (insérée entre Epic 8 et Epic 10, voir [`hardening-plan.md`](../.kiro/specs/athlya-platform/hardening-plan.md)) : H1 audit log SECURITY DEFINER, H2 DLQ drain, H3 circuit breaker per-isolate, H4 middleware chain tests, H5 `@athlya/ratelimit` extraction, H6 Axiom, H7 `.down.sql`, H8 README. Détail dans [CHANGELOG.md](../CHANGELOG.md).

## État des tests

Les compteurs de tests par package évoluent à chaque PR : la référence à jour est dans [`PROGRESS.md`](../.kiro/specs/athlya-platform/PROGRESS.md). La CI exécute à chaque PR les tests unitaires et d'intégration (Vitest), les tests property-based (fast-check), la suite pgTAP RLS sur les migrations, et les parcours E2E + axe sur les apps.

## Coûts opérationnels

La promesse "free tier solo" de l'analyse concurrentielle initiale n'est pas atteignable sur un déploiement prod + staging réel. Voici un TCO honnête pour un studio pilote.

| Poste                    | Free tier          | Coût au 1er user payant                           |
| ------------------------ | ------------------ | ------------------------------------------------- |
| Neon Postgres            | 500 MB, 1 projet   | **~19 €/mois** (Launch plan pour staging + prod)  |
| Upstash Redis            | 10 000 req/jour    | **~10 €/mois** dès le 1er studio actif            |
| Cloudflare Workers       | 100 000 req/jour   | **~5 €/mois** (Paid plan pour CPU time + Queues)  |
| Resend                   | 100 mails/jour     | **~20 €/mois** (Pro à partir de 3 000 mails/mois) |
| Sentry                   | 5 000 events/mois  | **~26 €/mois** (Team)                             |
| Axiom                    | 500 GB ingest/mois | **0 €** si volume modeste                         |
| Stripe                   | % des ventes       | variable                                          |
| Domaine + DNS            | —                  | **~15 €/an**                                      |
| **Total staging + prod** |                    | **~80-100 €/mois** au démarrage                   |

> Au-delà de ~5 studios actifs ou ~500 membres : prévoir **150-250 €/mois**.

Alerting et seuils par fournisseur : [`docs/runbooks/cost-monitoring.md`](../docs/runbooks/cost-monitoring.md).

Si la contrainte budgétaire est forte, plusieurs composants ont des chemins d'éjection vers du self-hosted sans coût récurrent — voir [Matrice fournisseurs](#matrice-fournisseurs).

## Limites assumées (v0.1)

Décisions arrêtées lors de la hardening phase, documentées dans [`hardening-plan.md`](../.kiro/specs/athlya-platform/hardening-plan.md).

### Circuit breaker — state per-isolate (H3)

L'état du circuit breaker (`packages/api/src/circuit-breaker.ts`) vit **en mémoire par isolate Cloudflare Workers**. Sous charge, un service downstream mort peut être touché par N requêtes (une par isolate vivant) à chaque cycle half-open, pas une seule globalement.

Accepté parce que :

- les isolates sont reapés après ~15 s d'inactivité, la dérive per-isolate se corrige d'elle-même
- la plateforme (Cloudflare retries, Hyperdrive fast-fail, Upstash SLA) absorbe déjà 90 % de la pression
- une version Redis coûterait +5-10 ms par appel downstream — contradiction directe avec le SLO p99 < 500 ms (Req 23.2)

### DLQ Cloudflare Queues — drain manuel (H2)

La DLQ `athlya-events-dlq` est drainée automatiquement par un worker consumer qui upsert chaque message dans un tracker Redis (`dlq:entry:<id>` + sorted set `dlq:pending`). La visibilité passe par des endpoints admin :

- `GET /admin/dlq/stats` — snapshot de la DLQ (admin-only, 403 Problem Details sinon)
- `POST /admin/dlq/replay/:id` — re-publication manuelle sur le bus (404 si inconnu)
- `POST /admin/dlq/discard/:id` — abandon de l'entrée (idempotent)

**Pas d'alerte automatique** sur DLQ non vide — à configurer côté Axiom avec une query sur le log structuré `"[dlq] drain cycle complete" AND totalPending > 0`.

### Testcontainers — skip-on-Docker

Les suites PBT P4 (cascade RGPD), P7 (tenant isolation) et properties `reservations` utilisent Testcontainers quand Docker est disponible. En local sans Docker, P7 peut retomber sur PGlite ; P4/P1 se skippent via `describe.skipIf(!dockerReady)`. En CI : **`integration-docker.yml`** exécute les PBT Docker sur chaque PR touchant `packages/db|members|reservations|api` ; **`pgtap.yml`** couvre les assertions SQL RLS sur les migrations.

### Exporter OTel — hand-rolled (task 8.6)

`packages/api/src/middleware/otel.ts` roule son propre exporter OTLP/HTTP JSON au lieu d'utiliser `@opentelemetry/sdk-trace-*`. Raison : bundle Worker ~200 KB évité. Compatible avec Axiom, Grafana Cloud, Honeycomb et tout backend OTLP standard. Conséquence : pas de debug via `otel-collector` CLI, envelope à maintenir nous-mêmes.

### Sentry — envelope minimal (task 8.7)

`packages/api/src/sentry.ts` envoie un envelope v7 POST direct au DSN ingest URL, sans `@sentry/cloudflare`. Fournit `captureException(err, { traceId, tags, extra })`. **Ne fournit pas** breadcrumbs, session tracking, release health, source maps upload. Pour passer à la vraie lib, remplacer le fichier le jour où le plan Sentry Team devient justifié.

## Vie privée — RGPD

Athlya est RGPD-first : le consentement granulaire, la portabilité et le droit à l'oubli sont des features de premier rang, pas une couche ajoutée.

### Consentement versionné

Chaque utilisateur a un champ `consents` JSON :

```json
{
  "marketing": false,
  "analytics": true,
  "thirdParty": false,
  "version": "2026-01",
  "updatedAt": "2026-05-10T10:23:00Z"
}
```

Chaque changement est horodaté avec la version des CGU en vigueur.

### Export self-service (Req 4)

`POST /v1/members/me/export` enfile un job asynchrone. Sous 48 h, un email avec un lien signé 72 h permet de télécharger un ZIP (JSON + CSV) contenant profil, consentements, réservations, séances, check-ins et factures.

### Droit à l'oubli (Req 5)

`DELETE /v1/auth/me` marque soft-delete puis un consumer Cloudflare Queues cascade les suppressions (réservations, sessions, push tokens, avatar R2). À J+30, un job cron anonymise les entrées `audit_log` référençant l'utilisateur via la fonction PostgreSQL **`SECURITY DEFINER`** `anonymize_user_audit(uuid)` — unique chemin de mutation autorisé sur la table append-only.

### Append-only audit log

L'intégrité de l'`audit_log` est garantie par **quatre lignes de défense** superposées :

1. **Privilèges SQL** — `REVOKE UPDATE, DELETE FROM PUBLIC, athlya_app, athlya_cron`
2. **Policies RLS** — `CREATE POLICY audit_no_update ... USING (false)`, idem pour DELETE
3. **Trigger** — `audit_log_immutable()` raise `audit_log is append-only` pour tout `current_user` différent de `athlya_owner`
4. **Ownership + BYPASSRLS** — table `audit_log` ownée par `athlya_owner`, qui exécute la fonction SECURITY DEFINER `anonymize_user_audit` (appelable par `athlya_cron` uniquement)

### Résidence EU

Données **au repos** en UE (Neon Frankfurt, Upstash EU, R2/Queues compte EU). Compute Workers via Smart Placement (co-localisation perf, pas pin `region_exclusive_eu` — voir `docs/security/eu-data-residency-adr.md`, Req 5.5).

## Procédure incident

1. Récupérer le **`x-trace-id`** depuis le header de réponse ou le front
2. **Axiom** — query `tags.trace_id = "<id>"` sur le dataset `athlya-api` (spans OTel avec `http.method`, `http.route`, `http.status_code`, `studio.id`, `user.id`)
3. **Sentry** — event avec tag `trace_id` pour la stack backend
4. **Wrangler Tail** — `wrangler tail --env production` pour les logs JSON en direct
5. **DLQ** — `GET /admin/dlq/stats` pour les messages non consommés sur le bus

### Rollback d'une migration

Préférer un **correctif en avant** : avec le schéma expand/contract, une migration fautive se neutralise par une nouvelle migration plutôt qu'en défaisant l'historique (voir [`expand-contract-migrations.md`](runbooks/expand-contract-migrations.md)).

Si un rollback est vraiment nécessaire :

1. Ne revenir que sur les **dernières** migrations appliquées, une par une, dans l'ordre inverse (la plus récente d'abord).
2. Vérifier que chaque migration visée a son `.down.sql`. Certaines n'en ont pas et sont **non réversibles** par conception (par exemple `0022` à `0025` : durcissement RLS, contraintes et index). Pour celles-là, écrire une migration corrective.
3. Appliquer, par exemple pour revenir sur `0041` :

```bash
psql "$MIGRATION_DB_URL" -v ON_ERROR_STOP=1 -f packages/db/migrations/0041_users_email_nullable.down.sql
```

4. Redéployer un Worker compatible avec le schéma obtenu, puis relancer `pnpm verify:role-contract`.

Les `.down.sql` sont idempotents (`DROP ... IF EXISTS`) et ne droppent jamais les extensions (`pgcrypto`, `citext`). Procédure détaillée : [`packages/db/migrations/README.md`](../packages/db/migrations/README.md#rollback-procedure).

## Matrice fournisseurs

Le vendor lock-in est un des griefs principaux adressés aux SaaS concurrents. Chaque fournisseur utilisé par Athlya a un chemin d'éjection documenté.

| Service            | Alternative                                       | Effort de migration                                   |
| ------------------ | ------------------------------------------------- | ----------------------------------------------------- |
| Neon Postgres      | Postgres 17 standard (Supabase, RDS, self-hosted) | 🟢 Faible — Drizzle portable, migrations SQL pures    |
| Upstash Redis      | Redis self-hosted, KeyDB, Dragonfly               | 🟢 Faible — API REST standard                         |
| Cloudflare Queues  | RabbitMQ, AWS SQS, QStash seul                    | 🟡 Moyen — outbox pattern préserve l'invariant        |
| Resend             | SMTP + nodemailer, Mailgun, Postmark              | 🟢 Faible — DI port dans `@athlya/notifications`      |
| Cloudflare Workers | Node.js standalone (Hono), Bun, Deno              | 🟡 Moyen — code framework-free, bindings à rebrancher |
| Stripe             | Adyen, Mollie, Lemon Squeezy                      | 🔴 Élevé — adapter Billing dédié                      |
| Axiom              | Grafana Cloud, Honeycomb, tout backend OTLP       | 🟢 Nul — endpoint configurable                        |
| Sentry             | Glitchtip (open-source), Highlight                | 🟡 Moyen — envelope v7 est un protocole stable        |

## Conventions du monorepo

- **pnpm 11 workspaces** + **Turborepo 2.11**
- **Node 24 LTS** pinné via `.nvmrc` + `engines`
- **TypeScript 6.0** strict, **ESLint 9** flat config, **Prettier 3**
- Packages domaine **framework-free** avec DI ports (Repo, Counter, Publisher, Store)
- **Hono** est peerDependency optionnelle de `@athlya/api` ; les middlewares sont duck-typés sur un contexte minimal `{ header(k,v); set; get; req; env }`
- **Zod `.strict()`** sur tous les bodies de requête sauf `AuditLog.metadata`
- **Branded IDs** via `.transform()` (pas `Zod.brand()`)
- **fast-check ^4** + `@fast-check/vitest` pour les PBT, `numRuns` 20-200, seeds hex fixes
- Testcontainers : sonde synchrone `docker info` au module load + `describe.skipIf(!dockerReady)` ; un test "infra probe" toujours enregistré
- Worker bundle : aucun import Node-only, `crypto.getRandomValues` / `crypto.randomUUID` globaux Web

### Structure des packages

```
packages/
├── api/            # Gateway Hono + middlewares (auth, tenant, otel, ratelimit, validator, problem-details)
├── auth/           # Service d'authentification, JWT, QR check-in
├── billing/        # Stripe Connect (DI port)
├── db/             # Schémas Drizzle, RLS policies, migrations + down.sql
├── members/        # Profils, consents, export/cascade RGPD
├── notifications/  # Consumer du bus → Resend + Expo Push
├── ratelimit/      # Sliding window Upstash (extrait de api en H5)
├── reservations/   # Domaine critique (bookClass, cancel, waitlist, checkin)
├── shared/         # Tokens design, i18n, schémas Zod, codecs, événements
├── eslint-config/  # Flat config partagée
├── prettier-config/
└── tsconfig/       # Presets base, node, react, next
```

## Stack détaillée

### Observabilité

| Signal      | Outil                        | Configuration                                           |
| ----------- | ---------------------------- | ------------------------------------------------------- |
| Traces OTel | **Axiom** (OTLP/HTTP JSON)   | endpoint configurable via `OTEL_EXPORTER_OTLP_ENDPOINT` |
| Logs        | JSON structuré, Axiom        | `traceId`, `method`, `path`, `status`, `durationMs`     |
| Métriques   | Cloudflare Analytics         | natif                                                   |
| Erreurs     | Sentry (envelope v7 minimal) | —                                                       |
| Uptime      | BetterStack                  | à configurer                                            |

### Sécurité

| Aspect           | Approche                                                      |
| ---------------- | ------------------------------------------------------------- |
| TLS              | 1.3 Cloudflare                                                |
| Auth             | JWT RS256 (access 15 min, refresh rotatif 30 j)               |
| Password         | bcrypt cost 12 + contrôle HIBP                                |
| Isolation tenant | RLS PostgreSQL `FORCE ROW LEVEL SECURITY`                     |
| Bot protection   | Cloudflare Turnstile sur register/login                       |
| Headers          | HSTS, X-Frame-Options, Referrer-Policy, CSP                   |
| Audit log        | Append-only (trigger + RLS `USING(false)` + SECURITY DEFINER) |

### Tests

| Niveau             | Outil                         | Nombre                   |
| ------------------ | ----------------------------- | ------------------------ |
| Unit + intégration | Vitest 5                      | voir `PROGRESS.md`       |
| Property-based     | fast-check 4                  | 9 invariants formels     |
| RLS PostgreSQL     | pgTAP en CI                   | ~60 assertions           |
| E2E + a11y         | Playwright 1.64 + axe-core    | CI `axe.yml` (`apps/**`) |
| Mobile (prévu)     | Maestro ou EAS Device Testing | —                        |

---
