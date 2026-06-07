## Résumé

Sentry intégré hand-rolled (envelope fetch). Pas de breadcrumbs, release health, **source maps upload CI**. Debug prod = stacks minifiées illisibles.

**Finding audit** : O1 — gravité **Medium**, priorité **P2**.

Issue #76 fermée (ADR SDK) — **source maps non branchées**.

## Solution proposée

### Phase 1 — Source maps CI

```yaml
# deploy job
- run: sentry-cli sourcemaps upload --release=$GIT_SHA ./dist
```

Secrets `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`

### Phase 2 — Release tracking

Tag events avec `release: git sha` + deploy marker

### Phase 3 — SDK migration (optionnel post maps)

`@sentry/cloudflare` si ADR validé

## Critères d'acceptation

- [ ] Stack trace prod lisible (fichier:ligne)
- [ ] Release associée aux events Sentry
- [ ] Test error staging → Sentry avec map

## Références

- `packages/api/src/observability/sentry.ts` (ou équivalent)
- Issue fermée #76
- Audit prod 2026-05-27 — O1

## Priorité

**P2**
