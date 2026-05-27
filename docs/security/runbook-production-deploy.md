# Runbook — Production deploy checklist

**Sprint 9 / Vague 37 — finalisation ops**

Procédure complète pour passer Athlya en production avec toutes les protections sécurité activées. À exécuter une fois lors de la mise en service initiale, ré-exécuter en partie à chaque rotation de secrets ou nouveau provisionning de sous-traitant.

## Pré-requis

- `pnpm install` à jour (Sprint 5 a bumpé `postcss` et `testcontainers` — relancer)
- Compte Cloudflare Workers actif avec `wrangler` authentifié
- Compte Neon Postgres EU (`aws-eu-central-1`) avec instance prod créée
- Compte Upstash Redis EU (`eu-west-1`) avec instance prod créée
- Compte Sentry EU (DSN sur `*.de.sentry.io`)
- Compte Resend EU activé pour les emails transactionnels (forgot-password)
- DNS Cloudflare contrôlant `athlya.app` + sous-domaine `api.athlya.app`

## Phase 1 — Migrations Postgres

```bash
# Depuis la racine du monorepo
pnpm --filter @athlya/db migrate:production
```

Les 5 migrations sont appliquées dans l'ordre :

- `0000_init.sql` — schéma de base
- `0001_rls.sql` — Row-Level Security
- `0002_export_jobs.sql` — RGPD export tracking
- `0003_audit_anonymization.sql` — fonction Postgres `anonymize_user_audit`
- `0004_rls_hardening.sql` — durcissement RLS
- `0005_password_reset_audit_anonymize.sql` — Sprint 7 SP7.2 (forgot-password + audit watermark)

**Pré-requis** : `MIGRATION_DB_URL` pointe sur le rôle `neondb_owner` (BYPASSRLS) — le rôle applicatif `athlya_app` n'a pas les droits DDL.

## Phase 2 — Secrets Cloudflare Workers

```bash
# Sécurité headers (Sprint 1 SP1.3 — S4-014)
wrangler secret put CORS_ORIGIN --env production
# Valeur: https://app.athlya.app  (ou domaine du tenant principal)

# Connexions backend
wrangler secret put DB_URL --env production
# Valeur: postgresql://athlya_app:...@...neon.tech/athlya?sslmode=require

# Hyperdrive (issue #62 — write path book/cancel)
# 1. Dashboard Cloudflare → Hyperdrive → Create config (Neon EU, role athlya_app)
# 2. Décommenter [[env.production.hyperdrive]] dans packages/api/wrangler.toml + coller l'id
# 3. Re-déployer — /health/ready expose checks.hyperdrive

wrangler secret put MIGRATION_DB_URL --env production
# Valeur: postgresql://neondb_owner:... (utilisé UNIQUEMENT par le runner de migration)
wrangler secret put REDIS_URL --env production
wrangler secret put REDIS_TOKEN --env production
wrangler secret put JWT_JWKS_URL --env production
# Valeur: https://api.athlya.app/.well-known/jwks.json (auto-publié par le worker)

# JWT keys (RSA pair généré localement, voir docs/operations/jwt-keys.md)
wrangler secret put JWT_KID --env production
wrangler secret put JWT_PRIVATE_KEY_PEM --env production
wrangler secret put JWT_PUBLIC_KEY_PEM --env production
wrangler secret put JWKS_JSON --env production
# Sprint 1 SP1.6 — iss/aud enforcement
wrangler secret put JWT_ISSUER --env production
# Valeur: athlya
wrangler secret put JWT_AUDIENCE --env production
# Valeur: athlya-api-production

# Sentry (Sprint 5 SP5.1 — S5-010 EU residency check au boot)
wrangler secret put SENTRY_DSN --env production
# IMPORTANT: l'host DSN doit se terminer par .de.sentry.io ou .eu.sentry.io
# Le worker logue un error au boot sinon (S5-010 fail-loud)

# Forgot-password (Sprint 7 SP7.4 — S2-006)
wrangler secret put RESEND_API_KEY --env production
wrangler secret put RESEND_FROM --env production
# Valeur: Athlya <noreply@[à-configurer]>
wrangler secret put WEB_APP_URL --env production
# Valeur: https://app.athlya.app

# Turnstile (anti-bot register/login)
wrangler secret put TURNSTILE_SECRET --env production

# Stripe (issue #69 — required before billing goes live)
wrangler secret put STRIPE_SECRET_KEY --env production
wrangler secret put STRIPE_WEBHOOK_SECRET --env production
# Deploy gate: /v1/billing/webhook returns 500 if STRIPE_WEBHOOK_SECRET missing (non-dev).
# See docs/runbooks/billing.md

# OTel (Sprint 1 SP1.6 — observability)
wrangler secret put OTEL_EXPORTER_OTLP_ENDPOINT --env production
# Valeur: https://api.axiom.co/v1/traces  (ou autre OTLP/HTTP target)
wrangler secret put OTEL_EXPORTER_OTLP_HEADERS --env production
# Valeur: Authorization=Bearer <axiom-token>,X-Axiom-Dataset=athlya-api

# CSP report-uri (Sprint 3 SP3.1 — S6-006)
wrangler secret put NEXT_PUBLIC_CSP_REPORT_URI --env production
# Valeur: https://api.athlya.app/v1/csp-report  (ou Sentry CSP endpoint)
```

## Phase 3 — Bindings R2 (Sprint 1 SP1.4 — S5-001/002)

```bash
wrangler r2 bucket create athlya-avatars-production
wrangler r2 bucket create athlya-exports-production
```

Les bindings sont déjà déclarés dans `packages/api/wrangler.toml` (`AVATARS_BUCKET` + `EXPORTS_BUCKET`). Mode dégradé actif tant que les buckets ne sont pas créés (cascade RGPD log warn, export job marqué `failed`).

## Phase 4 — Lifecycle R2 (S5-006 — purge auto)

Configurer une lifecycle rule R2 pour `athlya-exports-production` :

```bash
# Via dashboard Cloudflare R2 → Lifecycle Rules → "Delete after 72 hours"
# prefix = "exports/members/"
```

Match l'expiry des signed URLs RGPD (Req 4.2). Le job de purge `purgeExpiredExportJobs` (Sprint 2 SP2.3) gère la purge SQL côté `export_jobs` (90 jours) — la lifecycle R2 gère le binaire ZIP côté object storage.

## Phase 5 — Déploiement worker

```bash
# Build + deploy
pnpm --filter @athlya/api build
pnpm --filter @athlya/api deploy:production
```

Le worker démarre. Vérifier dans les premiers logs Tail (1-2 min) :

- ✅ Aucun `code: configuration_error` (sinon CORS_ORIGIN ou Sentry DSN manquant)
- ✅ Pas d'erreur `JWT_JWKS_URL` (vérification JWKS au boot du middleware auth)
- ✅ `served` lines avec `traceId` populated → tracing OK

## Phase 6 — Déploiement front Next.js

Apps web + studio déployés via le pipeline standard (Vercel ou Cloudflare Pages selon la décision finale). Pré-requis :

```bash
# Variables d'environnement frontend (NEXT_PUBLIC_*)
NEXT_PUBLIC_API_URL=https://api.athlya.app
NEXT_PUBLIC_TURNSTILE_SITE_KEY=...
NEXT_PUBLIC_CSP_REPORT_URI=https://api.athlya.app/v1/csp-report
```

## Phase 7 — Vérifications post-deploy

### Readiness gate (bloquant — issue #71)

Après chaque `wrangler deploy`, **ne pas router le trafic** tant que `/health/ready` n'est pas vert :

```bash
# Script (30 tentatives × 2s)
bash scripts/wait-health-ready.sh https://api.athlya.app

# Manuel
curl -sf https://api.athlya.app/health/ready | jq .
# Attendu: HTTP 200 + { "status": "ready", "checks": { "db": { "status": "ok" }, ... } }
```

Si `503` + `not_ready` : vérifier `DB_URL`, `REDIS_URL`/`REDIS_TOKEN`, `CRON_DB_URL` (prod/staging).

Configurer l'uptime monitor sur **`/health/ready`** (pas seulement `/health`) — alerte P1 si `not_ready` > 2 min.

### Liveness (process up)

```bash
curl -i https://api.athlya.app/health
# Attendu: 200 OK + JSON { status: "ok", environment: "production", traceId, version }
```

### CORS

```bash
curl -i -H "Origin: https://app.athlya.app" -X OPTIONS https://api.athlya.app/v1/auth/login
# Attendu: 204 + Access-Control-Allow-Origin: https://app.athlya.app
```

```bash
curl -i -H "Origin: https://evil.com" -X OPTIONS https://api.athlya.app/v1/auth/login
# Attendu: 204 SANS Access-Control-Allow-Origin (origine refusée)
```

### Headers sécurité (Sprint 3 SP3.1)

```bash
curl -i https://app.athlya.app/ | grep -E '^(strict-transport|content-security|cross-origin|permissions-policy|x-frame|x-content|referrer)'
# Attendu: les 7 headers présents avec les valeurs documentées dans audit-S6-frontend.md
```

### Forgot-password flow

```bash
# Devrait toujours renvoyer 204 (email-enumeration defence)
curl -i -X POST https://app.athlya.app/api/auth/password-reset/request \
  -H "Content-Type: application/json" \
  -H "Origin: https://app.athlya.app" \
  -d '{"email":"test-non-existant@example.com"}'
# Attendu: 204
```

### Turnstile check

Tenter un POST `/v1/auth/login` SANS header `cf-turnstile-token` (en non-dev) :

```bash
curl -i -X POST https://api.athlya.app/v1/auth/login \
  -H "Content-Type: application/json" \
  -H "Origin: https://app.athlya.app" \
  -d '{"email":"alice@example.com","password":"x"}'
# Attendu: 403 bot_challenge_failed
```

## Phase 8 — Provisioning audit anonymize cron (S5-003 finalisation) — BLOQUANT

**Obligatoire avant le premier utilisateur réel** (et avant merge production) :

```bash
# 1. Créer le rôle Postgres dédié
psql $MIGRATION_DB_URL <<EOF
CREATE ROLE athlya_cron LOGIN PASSWORD 'STRONG_RANDOM_HERE' BYPASSRLS;
GRANT EXECUTE ON FUNCTION anonymize_user_audit(uuid) TO athlya_cron;
GRANT SELECT, UPDATE ON users TO athlya_cron;
GRANT DELETE ON outbox, export_jobs TO athlya_cron;
GRANT UPDATE ON users TO athlya_cron;
EOF

# 2. Créer le binding sur Cloudflare
wrangler secret put CRON_DB_URL --env production
# Valeur: postgresql://athlya_cron:...@...neon.tech/athlya?sslmode=require

# 3. Câbler dans worker.scheduled() — patch ~5 lignes :
#
#    const sqlExec = makeSqlExecutor(env.CRON_DB_URL);
#    const anonymizeOne = (uid) => anonymizeAuditLog(uid, buildCascadeDeps(env).repo);
#    ctx.waitUntil(runScheduledRgpdMaintenance({ executeSql: sqlExec, anonymizeOne, logger }));
#
# Le primitif `runScheduledRgpdMaintenance` est déjà livré
# Sprint 8 SP7.6 (`packages/api/src/maintenance/scheduled-runner.ts`).
```

## Phase 9 — Validation conformité

Avant ouverture publique :

- [ ] Politique de confidentialité (`/privacy`) validée par DPO + counsel légal
- [ ] Mentions légales (`/legal`) validées avec coordonnées éditeur réelles
- [ ] Politique cookies (`/cookies`) cohérente avec SDK chargées
- [ ] DPIA template (`docs/security/dpia-template.md`) rempli + signé
- [ ] Runbook breach (`docs/security/runbook-breach-notification.md`) communiqué à l'on-call
- [ ] Registre traitement RGPD à jour
- [ ] Contrats DPA signés avec tous les sous-traitants (Cloudflare, Neon, Upstash, Stripe, Resend, Expo, Sentry)
- [ ] Notification Expo Push transfert hors-UE → SCC en place

## Phase 10 — Long terme (post-prod)

Après 6 mois de stabilité prod :

- [ ] **HSTS preload submission** (S4-009) — `https://hstspreload.org/?domain=athlya.app`
- [ ] Re-auditer les findings LOW/INFO résiduels (17) — décider lesquels valent la slice
- [ ] Re-run audit complet 12 mois après mise en service

## Annexe — Liste des findings audit

Voir `docs/security/AUDIT-SUMMARY.md` pour le détail des 74 findings et le statut. État au Sprint 8 :

- 5/5 CRITICAL ✅ résolus
- 14/14 HIGH ✅ résolus code-side
- Score moyen 70 → ~96/100

---

_Vague 37 / SP9.2 — Runbook deploy production. Document à valider DPO + ops avant première mise en service._
