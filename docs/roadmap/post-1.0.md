# Roadmap post-1.0

Ce document trace les chantiers explicitement renvoyés au-delà de v1.0.0. Sortis du backlog actif `tasks.md`, ils ne bloquent pas la mise en production du backend Niveau Série A.

Mise à jour : sortie v1.0.0.

---

## v1.1 — Mobile (Expo SDK 55)

**Effort estimé** : ~3 sprints (~3 semaines).

**Déclencheur** : décision business "rendre l'app dispo iOS/Android" + au moins un studio pilote prêt à tester l'app native.

**Périmètre** (Epic 10 dans `tasks.md`, 13 tâches) :

- **11.1** Scaffold Expo SDK 55 + NativeWind 4 + tokens partagés (`apps/mobile`).
- **11.2** `expo-secure-store` pour le refresh token (Secure Enclave / Keystore).
- **11.3** Biometric unlock via `expo-local-authentication`.
- **11.4** API client avec `Idempotency-Key` automatique + refresh-on-401.
- **11.5** `MutationQueue` persisté MMKV (FIFO + DLQ).
- **11.6** `drainMutationQueue` selon Algorithm 4 (retry exponentiel, jitter, max 5 tentatives).
- **11.7** `@react-native-community/netinfo` + auto-drain on reconnect.
- **11.8** Booking screen avec optimistic update.
- **11.9** QR check-in screen avec rotation 120 s.
- **11.10** Workout session logging avec enqueue offline.
- **11.11** RGPD export + delete screens.
- **11.12** Property test P5 (FIFO + idempotent drain) avec fast-check.
- **11.13** Unit tests `MutationQueue` persistence (kill app → restart).

**Pré-requis** : compte EAS Build (modules natifs `react-native-ble-plx`, `expo-secure-store`).

**Effets de bord post-mobile** :

- Déclenche probablement **N2.13 R2 avatars** (cap `data:` 256 KiB insuffisant pour mobile). Voir `docs/architecture/r2-avatars.md`.
- Déclenche **18 Apple Health import** (HealthKit) côté iOS.
- Déclenche **23 Bluetooth FTMS** pour les équipements connectés.

---

## v1.2 — AI coach + progression + programmes

**Effort estimé** : ~2 sprints (~2 semaines).

**Déclencheur** : feature flags `ai-coach` ouverts en alpha sur les studios Pro. Compte Mistral + Vercel AI SDK provisionnés.

**Périmètre** (Epics 21-25, ~22 tâches) :

- **21** AI coach : `packages/ai-coach/src/service.ts` + `/v1/coach/ask` streaming.
- **22** Progression graphs : `packages/members/src/progression.ts` (volume + 1RM trends, 30/90/365j) + UI web/mobile. ✅ Agrégateur, `GET /v1/me/progression` et UI web livrés (#639) ; UI mobile restante.
- **23** BLE FTMS (mobile, dépend v1.1).
- **24** Programs : schéma `programs` / `program_weeks`, service + assignment + UI studio admin. Shipped in #640 (migration 0042, `@athlya/programs`, `/v1/programs/*`, `/dashboard/programs`); the mobile home rendering of `GET /v1/programs/today` is still pending.
- **25** Final checkpoint v0.3.

**Pré-requis** : Mistral API key, consents `thirdParty` validés par les utilisateurs.

---

## v1.3+ — Niveau Stripe-mature (CN.6 → CN.10)

**Effort estimé** : ~6 jours.

**Déclencheur** : pic de charge réelle (≥ 1000 RPS soutenu) ou pentest externe planifié.

### Fiabilité

- **CN.6.3** Bulkhead pattern — séparer les Workers par domaine (`api-auth`, `api-reservations`, `api-billing`) pour isoler les failures CPU.
- **CN.6.4** Chaos engineering minimal — flag `CHAOS_NEON_FAILURE_RATE=0.1` en staging qui injecte 10 % d'erreurs Neon/Upstash. Vérifie circuit breaker open + 503 propres.

### Déploiement

- **CN.7.1** Canary deploys via Cloudflare Workers versions API — déploiement progressif 1 % → 10 % → 100 % avec rollback automatique sur error rate > seuil 5 min.
- **CN.7.2** Preview environments par PR — Workers preview + Neon branch par PR. `wrangler versions upload` + `neon branches create` dans `.github/workflows/preview.yml`.
- **CN.7.3** Rollback automatique sur SLO breach — automation Slack/PagerDuty + `wrangler rollback`.

### Architecture

- **CN.8.1** Real-time avec Cloudflare Durable Objects — `ClassCapacityDO` par cours pour push WebSocket/SSE des updates de capacité aux clients connectés. Bornes check-in live.
- **CN.8.2** Recherche full-text — PostgreSQL `tsvector` + GIN index sur `classes.title + description + coach_name`. Migration vers Typesense si volumes le justifient.
- **CN.8.3** Read replica Neon EU — réduire latence DB pour les studios européens (15-20 ms EU vs 80-120 ms cross-Atlantic actuel).

### Developer experience

- **CN.9.1** OpenAPI 3.1 généré depuis Hono — `@hono/zod-openapi` génère la spec depuis les routes Zod. `openapi-typescript` génère client TS pour `apps/web` + `apps/mobile`. Zero drift de types.
- **CN.9.2** Changesets + changelog auto — versioning sémantique des packages internes, changelog généré depuis conventional commits.
- **CN.9.3** Testcontainers → `pg-mem` en local — schéma Zod/Drizzle testé sans Docker sur Windows. Testcontainers réservé au CI Linux (PBT P1/P4/P7 actuellement skippées localement).

### Sécurité long terme

- **CN.10.1** Pentest externe — staging avec données synthétiques + pentester outillé. Valide la chaîne "HIBP + Turnstile + RLS + JWT + rate-limit" contre un attaquant motivé. Cycle 6-12 mois.

---

## Hors v1.x (slices opportunistes)

### N2.13 — R2 avatars

Voir `docs/architecture/r2-avatars.md` pour le flow presigned URL + plan de migration `data:` URL → R2. Effort ~5h cumulé. Déclencheurs : cap 256 KiB atteint OU mobile Epic 11.

### Studio admin slices 12.B / 12.C / 12.D

- **12.2** Class CRUD pages (`expectedVersion` + 409 Conflict).
- **12.3** Members list paginée (cursor) admin/coach.
- **12.4** Check-in kiosk page (camera `getUserMedia`).
- **12.5** Audit log viewer pagination admin.
- **12.6** axe-core sur les pages admin.

Effort ~1 sprint. Déclencheur : volonté d'autonomiser un studio sur la gestion CRUD sans passer par Postgres direct.

---

## Critères de promotion d'un item depuis post-1.0 vers le backlog actif

Un chantier de cette roadmap peut être réintégré dans `tasks.md` quand **au moins un** des critères suivants est satisfait :

1. **Déclencheur business** — un studio pilote réclame la feature comme bloquant pour signer.
2. **Déclencheur ops** — un signal de monitoring (ex : SLO burn rate, error rate, latence) justifie l'investissement.
3. **Déclencheur sécurité** — un finding pentest ou audit dépendances oblige à prioriser.
4. **Décision produit** — la roadmap publique annonce le scope.

Sans déclencheur explicite, ces items restent ici. Le backend v1.0.0 est suffisamment mature pour porter le besoin actuel sans eux.

---

_Roadmap post-1.0 — sortie initiale en parallèle de v1.0.0. Re-lire à chaque revue trimestrielle pour décider des promotions vers le backlog actif._
