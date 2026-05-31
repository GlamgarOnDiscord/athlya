## Contexte

Issue #138 (P2 infra, audit O1). Sentry est branché (envelope hand-rolled) et tague déjà `event.release = VERSION`, mais les **source maps ne sont pas uploadées** → stacks prod minifiées illisibles.

## Changements

- **`packages/api/wrangler.toml`** : `upload_source_maps = true` (wrangler émet `.js.map`).
- **`deploy-production.yml`** :
  - `staging-deploy` / `production-deploy` : ajout `--outdir dist` (génère bundle + map).
  - nouvelle étape **`Sentry release + source maps`** : `sentry-cli` release `${GITHUB_SHA:0:7}` → `sourcemaps inject` → `upload --release` → `set-commits --auto` → `finalize` → `deploys new -e <env>`.
  - **soft-gate** : skip propre si `SENTRY_AUTH_TOKEN`/`SENTRY_ORG`/`SENTRY_PROJECT` absents (fork PRs, secret non provisionné).
- **`docs/runbooks/sentry-sourcemaps.md`** + `verify-sentry-sourcemaps-checklist.mjs` + note secrets dans `security/README.md`.

## Pourquoi ça marche

Le nom de release = **sha court** = `VERSION` injecté au deploy (`--var VERSION=${GITHUB_SHA:0:7}`) = `event.release` émis par `packages/api/src/sentry.ts`. Sentry relie donc la map uploadée à l'event entrant (matching release + filename).

## Critères d'acceptation

- [x] Source maps uploadées + release associée (câblé CI)
- [x] Release associée aux events (déjà via `event.release`, doc)
- [ ] Test error staging → Sentry avec map : **à valider** après provisioning `SENTRY_*` en CI + 1er `staging-deploy` (procédure dans le runbook)

## Notes

- CI actuellement bloquée par le quota billing (#123/#034) — le workflow est prêt, validation runtime à faire au retour du quota.
- Phase 3 (`@sentry/cloudflare`) hors scope (taille bundle, cf. ADR #76).
- Canary/smoke : source maps non câblées sur ce chemin (Phase 1 cible les `*-deploy` directs) — noté runbook.

Closes #138
