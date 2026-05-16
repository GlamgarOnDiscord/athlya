<!--
  Merci pour ta contribution.
  Avant de soumettre, lire CONTRIBUTING.md pour les règles complètes.
  Cocher chaque case applicable ou expliquer pourquoi elle ne l'est pas.
-->

## Résumé

<!-- 2-3 phrases : qu'est-ce que cette PR change et pourquoi. -->

## Lien avec le plan d'implémentation

<!-- Indiquer la tâche, l'épic, ou l'item de hardening concerné. -->

- Closes #
- Related to: Epic X.Y / Task X.Y / H<n>

## Type de changement

<!-- Cocher une ou plusieurs cases. -->

- [ ] `feat` — nouvelle fonctionnalité
- [ ] `fix` — correction de bug
- [ ] `refactor` — réorganisation sans changement de comportement
- [ ] `perf` — amélioration de performance
- [ ] `docs` — documentation uniquement
- [ ] `test` — ajout ou amélioration de tests
- [ ] `chore` — tooling, CI, dépendances
- [ ] `security` — correction d'une vulnérabilité

## Description détaillée

<!-- Les fichiers clés modifiés, les nouvelles exports, les breaking changes.
     Pas besoin de lister tous les fichiers — le diff s'en charge. -->

## Tests

- [ ] `pnpm -r typecheck` passe
- [ ] `pnpm -r test` passe (indiquer le nombre de tests ajoutés)
- [ ] Si nouveau middleware : ajouté à `middleware-chain.test.ts`
- [ ] Si nouveau invariant : property-based test (fast-check) ajouté
- [ ] Si correction de bug : test qui échoue avant et passe après le fix

**Tests ajoutés** : <!-- nombre + description courte -->

## Migrations SQL

<!-- Uniquement si la PR touche à packages/db/migrations/. Sinon, laisser tel quel. -->

- [ ] Migration forward `NNNN_name.sql` ajoutée
- [ ] Rollback `NNNN_name.down.sql` ajouté et testé
- [ ] Tests pgTAP ajoutés dans `packages/db/tests/rls/`
- [ ] `run-all.sql` mis à jour

## Checklist qualité

- [ ] Aucun `any` ou `@ts-ignore` ajouté (ou justification documentée)
- [ ] JSDoc sur tout nouvel export public
- [ ] Pas de hard-coded string utilisateur (utiliser `@athlya/shared/i18n`)
- [ ] Pas d'import runtime de `hono` dans un middleware
- [ ] `pnpm format` exécuté
- [ ] `pnpm -r lint` passe

## Sécurité

- [ ] Pas de secret committé (`.env`, token, DSN, etc.)
- [ ] Pas de leak de `err.message` ou `err.stack` dans une réponse HTTP
- [ ] Si endpoint mutant : idempotence respectée, `Idempotency-Key` géré
- [ ] Si nouvelle surface HTTP : rate limit en place
- [ ] Si modif RLS : pgTAP confirme l'isolation cross-tenant

## Impact opérationnel

<!-- Cocher ce qui s'applique. -->

- [ ] Nouvelle env var / secret à provisionner (préciser laquelle)
- [ ] Migration SQL à appliquer avant déploiement (préciser laquelle)
- [ ] Breaking change sur un contrat API (préciser)
- [ ] Nouvelle dépendance (préciser + taille bundle si > 20 KB)
- [ ] Aucun impact opérationnel

## Points d'attention pour le reviewer

<!-- Ce qu'il faut regarder en priorité. Si zones incertaines, les nommer. -->

## Captures / logs

<!-- Optionnel : screenshots, output de test, traces Axiom/Sentry, etc. -->
