# Runbook — Sentry source maps & release tracking (issue #138)

## Objectif

Rendre les stack traces prod **lisibles** (`fichier:ligne` au lieu de bundle minifié) et associer chaque event Sentry à une **release** = sha git court.

## Comment ça marche

1. **Tag release sur les events** — déjà en place : le Worker émet `event.release = VERSION` (`packages/api/src/sentry.ts`), où `VERSION` est injecté au deploy (`--var VERSION=${GITHUB_SHA:0:7}`).
2. **Source maps** — `wrangler.toml` a `upload_source_maps = true` : `wrangler deploy --outdir dist` écrit `dist/*.js` + `dist/*.js.map`.
3. **Upload Sentry** — l'étape `Sentry release + source maps` (`.github/workflows/deploy-production.yml`) crée la release `${GITHUB_SHA:0:7}`, upload les maps, set-commits `--auto`, finalize, et enregistre un **deploy marker** (`-e staging|production`).

**Le nom de release = `VERSION` = sha court** : c'est ce qui permet à Sentry de relier la map uploadée à l'event entrant (matching par release + filename).

## Secrets / vars CI requis

| Clé | Type | Valeur |
|-----|------|--------|
| `SENTRY_AUTH_TOKEN` | secret | token avec scope `project:releases` + `org:read` (settings Sentry → Auth Tokens) |
| `SENTRY_ORG` | var | slug org Sentry |
| `SENTRY_PROJECT` | var | slug projet (ex. `athlya-api`) |

Soft-gate : si `SENTRY_AUTH_TOKEN`/`SENTRY_ORG`/`SENTRY_PROJECT` absents, l'étape **skip** (warning) sans casser le deploy.

## Vérification (critères d'acceptation)

1. **Stack trace lisible** : après un `staging-deploy`, déclencher une erreur test sur staging (route 5xx), ouvrir l'event dans Sentry → frames `worker.ts:LIGNE` (pas minifié).
2. **Release associée** : l'event porte `release: <sha7>` et apparaît dans Sentry → Releases avec un deploy marker `staging`.
3. **Test error staging → Sentry avec map** : cf. #1.

## Notes / limites

- **Matching** : on s'appuie sur le matching **release + filename** (event.release == nom de release uploadée). Le `sourcemaps inject` ajoute des debug-ids aux artefacts uploadés ; le bundle déployé par wrangler n'embarque pas ces ids (injection post-deploy locale), donc le debug-id matching seul ne suffit pas — d'où l'importance que `VERSION` == nom de release.
- **Canary / smoke** : `production-canary` passe par `scripts/canary-deploy.mjs` (versions upload) — source maps non câblées sur ce chemin (Phase 1 cible les phases `*-deploy` directes). Suivi possible si besoin.
- **Phase 3 (SDK `@sentry/cloudflare`)** : hors scope, rejetée pour la taille de bundle (cf. `sentry.ts` docblock + ADR #76).

## Références

- `.github/workflows/deploy-production.yml` — étape `Sentry release + source maps`
- `packages/api/wrangler.toml` — `upload_source_maps = true`
- `packages/api/src/sentry.ts` — `event.release`
- `scripts/verify-sentry-sourcemaps-checklist.mjs`
