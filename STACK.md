# Stack technique — Athlya

> Généré depuis les manifestes du dépôt. Pour les versions exactes, voir `package.json` et `pnpm-lock.yaml`.

---

## Monorepo

| Outil                              | Version         | Rôle                                                                                                            |
| ---------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------- |
| [Turborepo](https://turborepo.dev) | `^2.11.7`       | Orchestration builds, cache de tâches                                                                           |
| [pnpm](https://pnpm.io)            | `11.28.5`       | Gestionnaire de paquets, workspaces (overrides + réglages dans `pnpm-workspace.yaml`, `minimumReleaseAge` 24 h) |
| Node.js                            | `>=24.21.0 <25` | Runtime CI/CD — Node 24 LTS « Krypton » (`.nvmrc` 24.21.0)                                                      |
| TypeScript                         | `^6.0.3`        | Typage strict, mode `bundler` — TS 7 (natif) bloqué : typescript-eslint plafonne à `<6.1`                       |

---

## Applications

### `apps/web` — Interface membres

| Dépendance                      | Version   |
| ------------------------------- | --------- |
| Next.js (App Router, Turbopack) | `^16.4.0` |
| React / React DOM               | `^19.3.0` |
| Tailwind CSS 4 (CSS-first)      | `^4.3.3`  |
| @base-ui/react (headless UI)    | `^1.9.0`  |
| shadcn                          | `^4.21.4` |
| lucide-react                    | `^1.55.0` |
| next-themes                     | `^0.4.6`  |
| sonner (toasts)                 | `^2.0.8`  |
| tailwind-merge                  | `^3.7.0`  |
| class-variance-authority        | `^0.7.1`  |
| zod                             | `^4.6.5`  |

### `apps/studio` — Dashboard propriétaires de salles

Même stack que `apps/web`, avec en plus :

| Dépendance | Version  |
| ---------- | -------- |
| date-fns   | `^4.4.0` |

Les deux apps tournent sur Next.js 16 avec proxy-middleware (`src/proxy.ts`) qui injecte un nonce CSP par requête.

### `apps/mobile` — Member mobile app (foundation, post-1.0 v1.1)

| Dependency                      | Version  |
| ------------------------------- | -------- |
| Expo SDK                        | `~58.0`  |
| React Native (Hermes)           | `0.88.0` |
| expo-router                     | `~58.0`  |
| NativeWind (Tailwind 3)         | `^4.2.7` |
| react-native-mmkv               | `^4.3.2` |
| expo-secure-store               | `~58.0`  |
| expo-local-authentication       | `~58.0`  |
| @react-native-community/netinfo | `12.0.1` |

Details: [`docs/mobile/README.md`](docs/mobile/README.md).

---

## Packages internes

| Package                   | Description                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `@athlya/shared`          | Tokens design, i18n FR/EN, IDs brandés, schémas Zod, contrats events                              |
| `@athlya/db`              | Schéma Drizzle ORM, migrations, client tenant-aware, helpers outbox/idempotency                   |
| `@athlya/auth`            | Hachage bcrypt, HIBP breach check, JWT RS256/JWKS, tokens QR check-in, throttle login             |
| `@athlya/ratelimit`       | Sliding-window rate limiter Upstash, framework-free (extrait de `@athlya/api` en H5)              |
| `@athlya/api`             | Gateway Hono, middlewares auth/tenant/validator/otel/circuit-breaker, event bus drain             |
| `@athlya/reservations`    | State-machine réservations, `bookClass` two-phase Redis+Postgres, annulation + promotion waitlist |
| `@athlya/members`         | Use cases profil, consentements versionnés, export RGPD async, deletion cascade, séances sport    |
| `@athlya/billing`         | Stripe Connect checkout (DI port, sans SDK runtime), gestion webhooks                             |
| `@athlya/notifications`   | Consumer events bus, routage email (Resend) + push (Expo), déduplication Redis                    |
| `@athlya/eslint-config`   | Flat ESLint config partagée (base + react)                                                        |
| `@athlya/prettier-config` | Config Prettier partagée                                                                          |
| `@athlya/tsconfig`        | Preset tsconfig partagé                                                                           |

---

## Infrastructure & cloud

| Couche              | Technologie                                                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API runtime         | [Cloudflare Workers](https://workers.cloudflare.com) via Wrangler `^4.149.0`                                                                                                                                                                                       |
| Framework HTTP      | [Hono](https://hono.dev) `^4.13.13`                                                                                                                                                                                                                                |
| Base de données     | PostgreSQL (Neon serverless ou instance dédiée)                                                                                                                                                                                                                    |
| ORM                 | [Drizzle ORM](https://orm.drizzle.team) `^0.45.4`                                                                                                                                                                                                                  |
| Driver SQL          | postgres.js `^3.4.9` + `@neondatabase/serverless ^1.2.0`                                                                                                                                                                                                           |
| Cache / rate-limit  | [Upstash Redis](https://upstash.com) `^1.39.0`                                                                                                                                                                                                                     |
| Event bus           | Cloudflare Queues (DLQ configuré) + QStash (reminders 1h avant cours)                                                                                                                                                                                              |
| Notifications email | [Resend](https://resend.com)                                                                                                                                                                                                                                       |
| Notifications push  | [Expo](https://expo.dev) push service                                                                                                                                                                                                                              |
| Paiement            | Stripe Connect (SDK absent à runtime, HTTP natif)                                                                                                                                                                                                                  |
| Observabilité       | OpenTelemetry → [Axiom](https://axiom.co) (OTLP, endpoint configurable)                                                                                                                                                                                            |
| Erreurs runtime     | Sentry (enveloppe minimale, pas de SDK lourd)                                                                                                                                                                                                                      |
| Déploiement apps    | [Vercel](https://vercel.com)                                                                                                                                                                                                                                       |
| Placement Workers   | Smart Placement (`[placement] mode = "smart"`) — optimisation latence, **pas un pin région légal** ; les données au repos sont en UE (Neon `eu-central-1`, R2/Queues EU). Voir [`docs/security/eu-data-residency-adr.md`](docs/security/eu-data-residency-adr.md). |

---

## Sécurité

| Mécanisme            | Détail                                                                           |
| -------------------- | -------------------------------------------------------------------------------- |
| Authentification     | JWT RS256, JWKS rotation, `jose ^6.2.12`                                         |
| Hachage mot de passe | bcryptjs `^3.0.3`, cost 12                                                       |
| Breach check         | HIBP k-Anonymity à chaque login                                                  |
| Bot protection       | Cloudflare Turnstile (middleware prêt, intégration Epic 10.2)                    |
| TLS                  | TLS 1.3 via Cloudflare                                                           |
| Row-Level Security   | 26 politiques PostgreSQL RLS, 4 lignes de défense sur `audit_log`                |
| CSP                  | Nonce par requête, injecté dans `src/proxy.ts`                                   |
| Secret management    | `wrangler secret put` uniquement, jamais dans `wrangler.toml`                    |
| Headers HTTP         | `X-Frame-Options`, `HSTS`, `X-Content-Type-Options`, `Referrer-Policy` statiques |
| Rate limiting        | Sliding-window Upstash (`@athlya/ratelimit`)                                     |
| Idempotency          | Clé 24h Postgres, middleware Hono                                                |

---

## Tests

| Outil                               | Version    | Usage                                                      |
| ----------------------------------- | ---------- | ---------------------------------------------------------- |
| [Vitest](https://vitest.dev)        | `^5.0.3`   | Tests unitaires + intégration (tous packages)              |
| [fast-check](https://fast-check.io) | `^4.10.2`  | Property-based tests (8 invariants formels couverts)       |
| @testcontainers/postgresql          | `^12.2.0`  | Tests d'intégration Postgres réels (reservations, members) |
| [pgTAP](https://pgtap.org)          | via Docker | Suite RLS (26 politiques, script `test:rls`)               |
| @testing-library/react              | `^16.3.3`  | Tests composants React                                     |
| @playwright/test                    | `^1.64.0`  | E2E (`apps/web`)                                           |
| @axe-core/playwright                | `^4.13.0`  | Accessibilité E2E automatisée                              |
| jsdom                               | `^30.1.2`  | Environnement DOM pour Vitest (PointerEvent natif)         |
| Lighthouse                          | `^13.5.0`  | Audit performance (`scripts/lighthouse-check.js`)          |

Total : ~1 625 tests exécutés sur 10 packages (2026-10-12).

---

## Qualité & outillage

| Outil                    | Version   | Usage                                                                                |
| ------------------------ | --------- | ------------------------------------------------------------------------------------ |
| ESLint                   | `^9.39.5` | Flat config, `@typescript-eslint` strict — ESLint 10 bloqué par `eslint-config-next` |
| Prettier                 | `^3.9.10` | Formatage unifié                                                                     |
| [knip](https://knip.dev) | `^6.41.0` | Détection dépendances / exports morts (`pnpm check:dead`)                            |
| rimraf                   | `^6.1.3`  | Clean cross-platform                                                                 |

---

## CI/CD (GitHub Actions)

| Workflow           | Déclencheur                                        |
| ------------------ | -------------------------------------------------- |
| `ci.yml`           | Chaque PR — lint + typecheck + test + format check |
| `pgtap.yml`        | PR touchant `packages/db/migrations/**`            |
| `zap-baseline.yml` | OWASP ZAP baseline scan                            |
| `deps-audit.yml`   | Audit dépendances quotidien                        |
