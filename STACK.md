# Stack technique — Athlya

> Dernière mise à jour : mai 2026

---

## Monorepo

| Outil                            | Version    | Rôle                                  |
| -------------------------------- | ---------- | ------------------------------------- |
| [Turborepo](https://turbo.build) | `^2.9.12`  | Orchestration builds, cache de tâches |
| [pnpm](https://pnpm.io)          | `9.15.9`   | Gestionnaire de paquets, workspaces   |
| Node.js                          | `>=20 <21` | Runtime local (LTS)                   |
| TypeScript                       | `^5.9.3`   | Typage strict, mode `bundler`         |

---

## Applications

### `apps/web` — Interface membres

| Dépendance                      | Version   |
| ------------------------------- | --------- |
| Next.js (App Router, Turbopack) | `^16.2.6` |
| React / React DOM               | `^19.2.0` |
| Tailwind CSS 4 (CSS-first)      | `^4.3.0`  |
| @base-ui/react (headless UI)    | `^1.4.1`  |
| shadcn                          | `^4.7.0`  |
| lucide-react                    | `^1.14.0` |
| next-themes                     | `^0.4.6`  |
| sonner (toasts)                 | `^2.0.7`  |
| tailwind-merge                  | `^3.6.0`  |
| class-variance-authority        | `^0.7.1`  |
| zod                             | `^4.4.3`  |

### `apps/studio` — Dashboard propriétaires de salles

Même stack que `apps/web`, avec en plus :

| Dépendance       | Version   |
| ---------------- | --------- |
| date-fns         | `^4.1.0`  |
| react-day-picker | `^10.0.0` |

Les deux apps tournent sur Next.js 16 avec proxy-middleware (`src/proxy.ts`) qui injecte un nonce CSP par requête.

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

| Couche              | Technologie                                                                |
| ------------------- | -------------------------------------------------------------------------- |
| API runtime         | [Cloudflare Workers](https://workers.cloudflare.com) via Wrangler `^4.0.0` |
| Framework HTTP      | [Hono](https://hono.dev) `^4.12.18`                                        |
| Base de données     | PostgreSQL (Neon serverless ou instance dédiée)                            |
| ORM                 | [Drizzle ORM](https://orm.drizzle.team) `^0.45.2`                          |
| Driver SQL          | postgres.js `^3.4.5` + `@neondatabase/serverless ^1.0.0`                   |
| Cache / rate-limit  | [Upstash Redis](https://upstash.com) `^1.35.6`                             |
| Event bus           | Cloudflare Queues (DLQ configuré) + QStash (reminders 1h avant cours)      |
| Notifications email | [Resend](https://resend.com)                                               |
| Notifications push  | [Expo](https://expo.dev) push service                                      |
| Paiement            | Stripe Connect (SDK absent à runtime, HTTP natif)                          |
| Observabilité       | OpenTelemetry → [Axiom](https://axiom.co) (OTLP, endpoint configurable)    |
| Erreurs runtime     | Sentry (enveloppe minimale, pas de SDK lourd)                              |
| Déploiement apps    | [Vercel](https://vercel.com)                                               |
| Placement Workers   | EU uniquement (`[placement] mode = "smart"`)                               |

---

## Sécurité

| Mécanisme            | Détail                                                                           |
| -------------------- | -------------------------------------------------------------------------------- |
| Authentification     | JWT RS256, JWKS rotation, `jose ^5.9.6`                                          |
| Hachage mot de passe | bcryptjs `^3.0.2`, cost 12                                                       |
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
| [Vitest](https://vitest.dev)        | `^3.2.4`   | Tests unitaires + intégration (tous packages)              |
| [fast-check](https://fast-check.io) | `^3.23.2`  | Property-based tests (8 invariants formels couverts)       |
| @testcontainers/postgresql          | `^11.0.0`  | Tests d'intégration Postgres réels (reservations, members) |
| [pgTAP](https://pgtap.org)          | via Docker | Suite RLS (26 politiques, script `test:rls`)               |
| @testing-library/react              | `^16.1.0`  | Tests composants React                                     |
| @playwright/test                    | `^1.49.0`  | E2E (`apps/web`)                                           |
| @axe-core/playwright                | `^4.10.0`  | Accessibilité E2E automatisée                              |
| jsdom                               | `^26.0.0`  | Environnement DOM pour Vitest                              |
| Lighthouse                          | `^12.3.0`  | Audit performance (`scripts/lighthouse-check.js`)          |

Total : ~807 tests verts sur 10 packages.

---

## Qualité & outillage

| Outil                    | Version   | Usage                                                     |
| ------------------------ | --------- | --------------------------------------------------------- |
| ESLint                   | `^9.39.1` | Flat config, `@typescript-eslint` strict                  |
| Prettier                 | `^3.8.3`  | Formatage unifié                                          |
| [knip](https://knip.dev) | `^6.14.0` | Détection dépendances / exports morts (`pnpm check:dead`) |
| rimraf                   | `^6.0.1`  | Clean cross-platform                                      |

---

## CI/CD (GitHub Actions)

| Workflow           | Déclencheur                                        |
| ------------------ | -------------------------------------------------- |
| `ci.yml`           | Chaque PR — lint + typecheck + test + format check |
| `pgtap.yml`        | PR touchant `packages/db/migrations/**`            |
| `zap-baseline.yml` | OWASP ZAP baseline scan                            |
| `deps-audit.yml`   | Audit dépendances quotidien                        |
