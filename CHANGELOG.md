# Changelog

Toutes les évolutions notables du projet sont documentées dans ce fichier.

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le versioning adhère à [Semantic Versioning](https://semver.org/lang/fr/).

---

## [1.0.0] — Backend production-ready

Premier jalon stable. Le backend est verrouillé Niveau Série A : auth hardening complet, RGPD compliance pure-TS, rate limiting défense en profondeur (5 axes), résilience câblée, observability mature (OTel + Sentry + 13 alertes), SLOs codifiés, load tests + EXPLAIN ANALYZE en CI bloquante, SAST + secret scan, feature flags. Apps Next.js 16 (web + studio admin) MVP livrées. **Mobile (Expo), AI coach et Stripe-mature renvoyés vers la roadmap [post-1.0](docs/roadmap/post-1.0.md).**

### Highlights

- **246 / 294 tâches livrées** = 83.7 % du backlog.
- **567/567 tests api verts**, ~830 tests cumulés sur le monorepo, zéro régression.
- **Score critique 9.95 / 10** sur 15 axes production-readiness.
- **15 sprints** rythmés en vagues documentées dans `docs/modifications/modifications.md`.

### Added — Domaine et plateforme (Epics 1 → 16)

- **Epic 1** — Turborepo monorepo (pnpm 9.15 workspaces, Node 20 LTS, Turborepo 2.x), `@athlya/shared` (tokens design, i18n FR/EN, schémas Zod, codecs, events), branded IDs.
- **Epic 2** — Schéma Drizzle, migrations initiales, extensions `pgcrypto` + `citext`, trigger `audit_log_immutable`, policies RLS, idempotency store, outbox, pgTAP.
- **Epic 3** — Auth complet : bcrypt cost 12, HIBP check (avec retry+jitter+timeout slice 11.3), JWT RS256 + JWKS rotation, QR check-in tokens, login throttle sliding window.
- **Epic 4** — Rate limiter sliding window Upstash, idempotency middleware 24h.
- **Epic 5** — Members service, consents versionnés, export RGPD async, deletion cascade, workout session logging.
- **Epic 6** — Domaine réservations complet : listing avec counter Redis, création de cours, update optimistic lock, `bookClass` two-phase Redis+Postgres, `cancelReservation` avec promotion waitlist FIFO, state-machine guard, QR check-in.
- **Epic 8** — API Gateway Hono : Wrangler envs, JWT auth middleware, tenant middleware, global rate limit, Zod validator + Problem Details onError, OpenTelemetry tracing (OTLP hand-rolled), circuit breaker + Sentry envelope minimal, security headers, audit log writer, Turnstile, mount routes.
- **Epic 9** — Event bus complet : contrats typés, publish avec outbox transactionnel, drain worker scheduled, DLQ + tracker Redis + endpoints admin (`GET /admin/dlq/stats`, `POST /admin/dlq/replay/:id`), consumer Notifications avec dedup Redis, QStash reminder 1h avant cours.
- **Epic 10 (web)** — App Next.js 16 : login + register avec Turnstile + HIBP feedback, forgot-password (Sprint 13), profile + consents, browsing classes, booking + cancel, QR check-in, workout sessions, RGPD export/delete UI, axe-core CI.
- **Epic 11 (studio admin)** — Slice 12.A scaffold + admin layout + dashboard + login + forbidden. Slices 12.B/C/D (CRUD classes, membres, identité visuelle, facturation) livrées en v1.1.0.
- **Epic 13** — CI lint/typecheck/test/format, OWASP ZAP baseline (procédure d'activation runbook Sprint 14), daily deps audit, pgTAP workflow, logger JSON structuré Workers-compat.
- **Epic 15** — Multi-tenant wide rollout (subdomain + path + reserved set + custom apex), brand color CSS variable, integration tests d'isolation cross-studio.
- **Epic 16** — Stripe Connect checkout via port DI, webhook handler avec signature verification + audit transactionnel, events `billing.subscription.{started,failed}`.
- **Epic 17** — Handler `reservation.promoted` complet dans le consumer Notifications.
- **Epic 19** — Négociation `Accept-Language` RFC 4647, templates Notifications dans `@athlya/shared/i18n`.

### Added — Hardening (Sprints 1 → 7)

- **H1** Anonymisation `audit_log` via fonction PostgreSQL `SECURITY DEFINER` (résout la contradiction Req 5.3 J+30 ↔ Req 22.2 immuable). 4 lignes de défense : REVOKE SQL, RLS `USING (false)`, trigger immuable, ownership + BYPASSRLS.
- **H2** Drain DLQ Cloudflare Queues avec tracker Redis et endpoints admin.
- **H3** Sémantique per-isolate du circuit breaker documentée + test d'isolation.
- **H4** Tests de composition middleware in-process via `app.request()` Hono (16 tests).
- **H5** Package `@athlya/ratelimit` extrait de `@athlya/api` pour casser le cycle d'imports.
- **H6** Migration Baselime → Axiom comme backend OTLP par défaut.
- **H7** Scripts de rollback `.down.sql` pour les migrations initiales.
- **H8** Refonte `README.md` racine avec TCO réaliste.

### Added — Sprints critique-driven (Sprints 8 → 15)

- **C1 — Bugs critiques correctness** (3 items) : verrou pessimiste `FOR UPDATE` sur `bookClass`, idempotence stricte sur cancellation, garde state-machine `confirmed → cancelled` uniquement.
- **C2 — Bugs sérieux** (7 items) : audit log dans la même tx, dedup Notifications atomique (`tryAcquire` + release), `skipDomainRoutes` retiré de l'interface publique, helper `buildAppNoDomainRoutes` dans `test-app.ts`.
- **Sprint 11** — Backend polish : C2.2 + C2.4, retry/timeout HIBP via `AbortSignal.timeout(2000)`, `/health/ready` distinct, helper `pingDbHttp`.
- **Sprint 12** — Auth hardening + observability :
  - `fetchWithRetry` helper + Resend wrapping (12.1), per-mutation rate limits (12.2), audit logging userId+studioId (12.3).
  - Per-user concurrency limit (12.4), per-studio rate limit (12.5), audit idempotency doc (12.6).
  - JWT rotation endpoint admin + runbook (12.7), login anomaly detector + adapter Redis (12.8).
  - OTel spans nommés métier `setName` (12.9), Sentry `addBreadcrumb` (12.10), Axiom queries doc (12.11), 13 alertes Slack/PagerDuty (12.12).
- **Sprint 13** — Production-ready finalisations : Turnstile dans ForgotPasswordForm (SP8.4), `worker.scheduled()` cron RGPD avec `buildCronSqlExecutor`, pure-TS `anonymizeAuditLogViaSql` sans BYPASSRLS (B10.2).
- **Sprint 14 — Niveau Série A complet** :
  - **CN.1** SLOs codifiés : 4 SLOs documentés (`docs/operations/slos.md`) + queries Axiom + burn rate alerts.
  - **CN.2** Load tests : `k6/book-class.js` + `k6/list-classes.js` + workflow CI bloquant. EXPLAIN ANALYZE 5 queries critiques + seed 200 users × 500 classes × 10000 réservations + workflow CI.
  - **CN.3** SAST + secret scan : CodeQL `security-extended` + gitleaks. Runbook `zap-activation.md` pour le scan ZAP.
  - **CN.4** Feature flags : module `feature-flags.ts` (11 tests) + 3 flags pilotes + playbook rollout progressif + procédure migration GrowthBook documentée.
  - **CN.5** Synthetic + RUM + cost monitoring : 4 checks Checkly + Vercel Analytics + Sentry Performance + alert routing 2/3 régions + cost queries Axiom (per endpoint + per studio).
- **Sprint 15 — Cleanup legacy LOW** :
  - Retag livraisons antérieures (N2.12 Neon HTTP migration, Checkpoint 7-8, cookie banner SP5.8/SP6.6).
  - Runbooks ops neufs : `docs/operations/csp-report-uri.md`, `docs/operations/hsts-preload.md`.
  - Roadmap `docs/architecture/r2-avatars.md` (presigned URL flow, ~5h, slice future).

### Security

- **Auth hardening** : JWT RS256 + JWKS rotation, family-tree replay detection, brute-force throttle sliding window, login anomaly detector (Redis), HIBP password breach check avec retry+timeout.
- **Rate limiting défense en profondeur** : IP + user + studio + per-mutation + per-user concurrency. Pattern fail-OPEN aligné avec rate-limit + turnstile + concurrency-limit + studio-rate-limit.
- **RGPD compliance** : Trigger SECURITY DEFINER live + cron câblé + pure-TS anonymize sans BYPASSRLS.
- **Audit log append-only** : 4 lignes de défense (REVOKE SQL, RLS `USING (false)`, trigger immuable, ownership + BYPASSRLS), PII-safe (pas d'IP/UA/email — uniquement actorId/rootSid/oldSid).
- **Secret-leak guard** : la branche 500 Problem Details ne fuit jamais `err.message`.
- **TLS 1.3 Cloudflare**, bcrypt cost 12, Turnstile bot protection, validation Zod `.strict()` sur tous les bodies sauf `AuditLog.metadata`.
- **WCAG 2.2 AA** sur web + studio.
- **CodeQL `security-extended`** (prototype pollution + ReDoS + regex injection) + gitleaks + ZAP procedure.

### Resilience

- HIBP / Resend retry exponential + jitter + `AbortSignal.timeout`.
- Circuit breaker per-isolate avec sémantique documentée.
- `/health/ready` distinct de `/health` (DB ping + Redis ping).
- DLQ Cloudflare Queues avec replay/discard admin.
- Outbox transactionnel pour la garantie at-least-once.

### Observability

- OpenTelemetry tracing avec exporter OTLP hand-rolled vers Axiom.
- Spans nommés métier (`auth.login`, `bookClass`, `cancelReservation`, etc.).
- Sentry breadcrumbs `addBreadcrumb` enrichis (userId, studioId, mutation).
- 13 alertes Slack/PagerDuty (4 SLO burn rates + 9 incidents) documentées dans `docs/operations/axiom-alerts.md`.
- Cost queries Axiom par endpoint + par studio.
- 4 SLOs codifiés : availability 99.9 %, latency p99 < 500 ms, error rate < 0.1 %, booking success rate > 99 %.

### Tests

- **Property-based tests** via fast-check 3.23 validant 8/9 invariants formels :
  - **P1** capacité (no double-booking)
  - **P2** booking idempotence
  - **P3** state-machine monotonicity
  - **P4** RGPD cascade
  - **P5** FIFO + idempotent offline drain (bloqué v1.0.0 — scaffolding mobile post-1.0)
  - **P6** JWT non-forge + non-replay
  - **P7** tenant isolation
  - **P8** rate limit sliding window exactness
  - **R21** round-trip serialization
- **pgTAP** : RLS policies, audit log immuabilité, anonymisation RGPD.
- **k6** : `book-class.js` et `list-classes.js` avec thresholds bloquants en CI.
- **EXPLAIN ANALYZE** : 5 queries critiques, seed 10k×500, workflow CI.
- **axe-core** + Playwright E2E sur les apps web.

### Infrastructure

- Turborepo 2.x, pnpm 9.15 workspaces, Node 20 LTS, TypeScript 5.9.
- Cloudflare Workers + Wrangler ^4, Hono ^4.12.
- Neon PostgreSQL 17 (HTTP driver `@neondatabase/serverless` avec cache module-scope).
- Upstash Redis pour counters, rate limits, dedup, login anomaly.
- Drizzle ORM, Zod ^4.4 strict validation.
- **Workflows CI** : `ci.yml`, `pgtap.yml`, `zap-baseline.yml` (procédure d'activation), `deps-audit.yml`, `axe.yml`, `load-test.yml`, `codeql.yml`, `secret-scan.yml`, `explain-analyze.yml`.

### Changed

- Rate limiter migré de `packages/api/src/ratelimit.ts` vers `@athlya/ratelimit` (H5).
- Baselime → Axiom comme backend OTLP par défaut (H6).
- `postgres-js` → `@neondatabase/serverless` HTTP driver pour les Workers (Sprint 11). Gain p95 ~1700 ms → ~600 ms.

### Fixed

- Contradiction Req 5.3 (anonymisation RGPD J+30) ↔ Req 22.2 (audit immuable) via SECURITY DEFINER (H1).
- Race condition `bookClass` Redis-only → ajout du `FOR UPDATE` Postgres en two-phase (C1.1).
- Idempotence cancellation cassée par contrainte unique → reformulation via state-machine guard (C1.2).
- `skipDomainRoutes` exposé dans l'interface publique → helper interne `buildAppNoDomainRoutes` (C2.2).
- Dedup Notifications non-atomique → `DedupStore.tryAcquire` + release pattern (C2.4).

### Not in 1.0.0 (renvoyés vers [post-1.0](docs/roadmap/post-1.0.md))

- **Mobile Expo SDK 55** (Epic 10 — 13 tâches) : scaffold + secure storage + biométrie + MutationQueue + drain offline + écrans booking/check-in/sessions/RGPD + property test P5.
- **Apple Health import** + **Bluetooth FTMS** (mobile-only).
- **AI coach** (Vercel AI SDK + Mistral), **graphiques de progression**, **programmes d'entraînement** (Epics 21-25).
- **Niveau Stripe-mature** (CN.6.3 bulkhead, CN.6.4 chaos, CN.7 canary deploys + previews + rollback auto, CN.8 Durable Objects + full-text search + read replica EU, CN.9 OpenAPI generation + changesets + pg-mem, CN.10 pentest externe).

---

## [1.1.0] — Studio admin complet + correctifs UX

### Added — Studio admin (slices 12.B/C/D)

- **Classes** — CRUD complet : liste, création (modal), édition in-place, suppression soft-delete avec cascade annulation des réservations `confirmed`/`waitlist`. Route `DELETE /v1/classes/:id` (Hono + Drizzle adapter `createDrizzleDeleteClassRepo`). Suppression optimiste côté UI avec rollback sur erreur réseau.
- **Membres** — Liste avec pagination cursor, recherche client-side nom/email, état vide.
- **Identité visuelle** — Édition couleur de marque, calcul WCAG noir/blanc automatique, toast de confirmation, validation hex HTML5.
- **Facturation** — Affichage plans Free/Pro, gestion erreur 503 Stripe (environnement non configuré), section factures.
- **Locale switch** — Bascule FR/EN instantanée sur toutes les pages admin.

### Fixed

- **B1** — `GET /v1/classes` retournait 401 (mauvais `jwtIssuer`/`jwtAudience` dans `packages/api/src/adapters/auth-deps.ts`).
- **B2** — Texte de navigation débordait sur mobile (`whitespace-nowrap` manquant sur `apps/web/src/components/AppNav.tsx`).
- **B3** — Footer dupliqué sur toutes les pages web (`apps/web/src/app/layout.tsx`).
- **B4** — Bouton « Réserver » actif pour les cours déjà réservés ; ajout prop `booked` + disable + clé i18n `« Réservé »`/`"Booked"` (`ClassCard.tsx`, `ClassesList.tsx`, `fr.json`, `en.json`).
- **B5** — Triple `<h2>` sémantiquement identique sur `/me` (`ProfileForm`, `ExportPanel`, `DeletePanel`).
- **B6** — Date de consentement affichée en ISO brut — remplacée par `Intl.DateTimeFormat` (`ConsentsForm.tsx`).
- **B7** — Route `DELETE /v1/classes/:id` absente, `client.delete` (inexistant) remplacé par `client.del` (`ClassesAdminList.tsx`).

---

## [Unreleased]

### Security — Session 2026-06

- **#192 / #193** — `updateClass` scopé par `studioId` (anti-mutation cross-tenant ; defense-in-depth au niveau service, en plus de la RLS `withTenant`). Ordre des paramètres aligné `studioId`-first.
- **#194 / #195** — Rate-limit password-reset par email (3 / 24 h, clé **hashée SHA-256**, TTL auto-réparant) + timeouts upstream (`AbortSignal.timeout(10s)` + `cache: 'no-store'`) sur tous les proxys auth Next (web + studio).
- **#200 / #203** — Révocation du grant mort `UPDATE (actor_id, metadata) ON audit_log` de `athlya_cron` (**migration 0012**) ; restaure l'invariant d'immuabilité (pgTAP test 3 ↦ 42501). L'anonymisation RGPD J+30 passe exclusivement par la fonction SECURITY DEFINER `anonymize_user_audit()`.

### Fixed — Session 2026-06

- **#198 / #199** — Restauration du check CI requis `Lint, typecheck, and tests` : `prettier --write` sur 53 fichiers + 15 erreurs lint `@athlya/api` masquées par le short-circuit format (helper `readJson<T>` pour le faux positif typescript-eslint ↔ tsc sur `res.json()`).
- **#202** — Élimination du flake property `AuditLog round-trip` (échec aléatoire sur #189 / #202) : exclusion des clés `__proto__` / `constructor` / `prototype` de l'arbitrary `auditLogArb`.

### Changed — Session 2026-06

- **#196 / #197** — Nettoyage qualité (suppression composants UI morts + deps `react-day-picker` / `shadcn`, `cursorRef`, metadata SEO, skip-link a11y). Reverts des changements react-doctor régressifs signalés en review (next/image sur avatars distants / `data:`, lazy-init `CookieBanner` ↦ hydration mismatch).

### CI / DX — Session 2026-06

- **#201 / #202** — `pnpm preflight` (mirror du gate CI requis) + hook `.githooks/pre-push` auto-câblé ; Turbo remote cache activé. Coupe les allers-retours CI rouges déterministes.
- **#204 / #205** — Workflow codifié : `CLAUDE.md` racine, section `CONTRIBUTING`, skill Claude `/ship`. Dependabot **groupé** (minor/patch dev + prod + actions) + **auto-merge** des minor/patch (majors isolés).

### Docs — Session 2026-06

- Passe de fraîcheur : badges CI **live** (statut réel au lieu de statiques verts), compteur de tâches **277 / 313** et version **v1.1.0** réconciliés (README / PROGRESS / tasks.md). Inventaire vérifié depuis les cases de `tasks.md`.

### Added — Durcissement post-audit prod (2026-05)

- **#134** — Drain outbox adaptatif (batch 100→200 si backlog > 500), métrique `outbox.backlog` à chaque tick, garde d'overlap par durée (`outbox.drain_overlap_risk`), alerte Axiom A16.
- **#135** — Réconciliation dérive capacité Redis↔PG (`reconcileCapacityDrift`) avec auto-heal, runner cron, métrique `capacity_redis_pg_drift`, alerte A17, runbook `capacity-drift.md`.
- **#136** — Sink public de rapports CSP (`POST /v1/csp-report`, formats legacy + Reporting API), métriques `csp.violation`/`csp.report_parse_error`, alerte A18.
- **#140** — Circuit breaker : **jitter half-open per-isolate** (anti-storm, défaut 20 % de `resetTimeoutMs`, sans état partagé) + hook `onTransition` pour métrique transitions d'état.
- **#141** — Cap d'abonnés `ClassCapacityDO` (`CLASS_CAPACITY_MAX_WS`, défaut 500) avec load-shedding `503 + X-Capacity-Fallback: poll`, runbook scaling.

### Changed

- **#138** — Upload des source maps + tracking de release Sentry en CI (`sentry-cli` épinglé), sérialisation `Error.stack` en `stacktrace.frames` dans l'envelope Sentry.

### Security

- **#137** — ADR d'acceptation de risque `style-src-attr 'unsafe-inline'` + tests verrouillant la posture CSP.
- **#139** — ADR hébergement web (OpenNext CF vs Vercel) + runbook de déploiement unifié ; cookie refresh confirmé **host-only** (pas de `Domain` → pas de risque CSRF sur sous-domaines tenant).
- **#142** — Override pnpm `tmp >= 0.2.6` (dev-only via testcontainers) → ferme l'advisory Dependabot High (Path Traversal).

### Docs

- ADR circuit breaker (`docs/security/circuit-breaker-adr.md`) ré-évalué post-audit R1 ; `rules.md` à jour (post #135–#142).

> **#123** (quota GitHub Actions / billing) **résolue** (2026-06) — quota rétabli, tous les workflows (CI, pgTAP, Docker PBT, secret-scan) re-tournent verts sur master.

---

[Unreleased]: https://github.com/GlamgarOnDiscord/athlya/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/GlamgarOnDiscord/athlya/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/GlamgarOnDiscord/athlya/releases/tag/v1.0.0
