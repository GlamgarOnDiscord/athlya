## Contexte

Dependabot alert #9 (**High**) : `tmp < 0.2.6` — Path Traversal via prefix/postfix non sanitizé (directory escape). Patché en `0.2.6`.

## Analyse

`tmp@0.2.5` est **transitif et dev-only** : `testcontainers@11.14.0 → tmp@0.2.5`. Aucune surface runtime/prod (testcontainers ne sert qu'aux tests d'intégration Docker). Blast radius réel ≈ nul, mais l'advisory High doit être fermé (badge README + gate supply-chain).

## Fix

Override pnpm ciblé (même style que les overrides existants `miniflare>ws`, `dockerode>uuid`) :

```json
"testcontainers>tmp": "^0.2.6"
```

Lockfile régénéré → `tmp@0.2.7` (≥ patch), version unique dans l'arbre. Override scopé à testcontainers pour ne pas masquer une future réintroduction de `tmp` par une autre dépendance.

## Vérification

- `pnpm-lock.yaml` : `tmp@0.2.7` seul, plus aucun `tmp@0.2.5`.
- Override dev-only → zéro impact runtime.

## Critères d'acceptation

- [x] 0 High/Critical (tmp patché ≥ 0.2.6).
- [x] PR upgrade.
- [ ] Badge README vert (auto après merge + re-scan Dependabot).

Closes #142
