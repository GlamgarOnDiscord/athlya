## Résumé

Quota GitHub Actions épuisé (contexte projet) → **CI morte sur PR/master**. Aucune gate lint/test/deploy ne tourne. Badges README "CI passing" **obsolètes**.

**Finding audit** : R4 — gravité **High**, priorité **P0 process**.

Issue #67 (CI gates mandatory) fermée avec workflow code — **inutile si Actions billing KO**.

## Comportement observé

- PR mergées sans `ci.yml` vert
- Testcontainers PBT, pgTAP, integration-docker **non exécutés**
- Régressions (RLS, booking, notifications) passent undetected

## Impact production

- **Aucune assurance qualité** sur merges récents (#101–#116)
- Dette technique accumulée invisible
- Compliance supply chain (deps-audit, codeql) arrêtée

## Solution proposée

### Option A — GitHub billing

1. Settings → Billing → augmenter minutes Actions
2. Vérifier `ci.yml`, `pgtap.yml`, `integration-docker.yml` verts sur `master`

### Option B — Self-hosted runners

1. Runner dédié (VM EU) pour jobs Docker lourds
2. Labels `runs-on: [self-hosted, linux]`

### Option C — Migration partielle

- Lint/typecheck sur runner self-hosted
- Garder GH-hosted pour jobs légers

### Validation post-fix

- Branch protection : require status checks `ci`, `pgtap`, `integration-docker`
- Documenter dans `docs/runbooks/ci-recovery.md`

## Critères d'acceptation

- [ ] `master` CI verte 3 runs consécutifs
- [ ] Branch protection enforced (vérifier `branch-protection.md`)
- [ ] Badge README reflète état réel
- [ ] Runbook recovery CI documenté

## Références

- `.github/workflows/ci.yml`
- `docs/runbooks/branch-protection.md`
- Audit prod 2026-05-27 — R4

## Priorité

**P0 process** — gouvernance code morte sans CI
