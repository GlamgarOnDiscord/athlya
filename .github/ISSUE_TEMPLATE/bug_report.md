---
name: Rapport de bug
about: Signaler un comportement incorrect ou une erreur
title: '[bug] '
labels: bug, triage
assignees: ''
---

## Résumé

<!-- Une phrase courte décrivant le bug. -->

## Comportement attendu

<!-- Ce qui devrait se passer. -->

## Comportement observé

<!-- Ce qui se passe réellement. -->

## Reproduction

### Environnement

- **Package** : `@athlya/…` (api, auth, reservations, …)
- **Version / commit** : <!-- `git rev-parse HEAD` ou version du package -->
- **Environnement** : <!-- dev local, staging, production, CI -->
- **Node** : <!-- `node --version` -->
- **pnpm** : <!-- `pnpm --version` -->
- **OS** : <!-- Windows 11 / macOS / Linux -->
- **Docker disponible** : <!-- oui / non (impacte les suites Testcontainers) -->

### Étapes

1.
2.
3.

### Minimum reproducible example

<!-- Bloc de code, snippet de test, ou lien vers un gist. -->

```ts
// ...
```

## Trace / logs

### Trace id

<!-- Récupérer le header `x-trace-id` de la réponse si possible. -->

`traceId`:

### Logs Worker (Axiom / Wrangler Tail)

<!-- Coller la ligne JSON structurée correspondante si disponible. -->

```json

```

### Sentry event (si 5xx)

<!-- Lien vers l'event ou `event_id`. -->

### Réponse HTTP (si API)

- **Status** :
- **Body** (si Problem Details) :

```json

```

## Impact

- [ ] Bloquant (pas de workaround)
- [ ] Dégradation (workaround existe)
- [ ] Cosmétique

## Hypothèse / piste

<!-- Optionnel : si tu as une intuition sur la cause, la partager. -->

## Checklist

- [ ] J'ai vérifié que le bug n'est pas déjà ouvert dans les issues
- [ ] J'ai testé avec la version la plus récente de `main`
- [ ] J'ai fourni une reproduction minimale
- [ ] Ce n'est PAS une vulnérabilité de sécurité (sinon → security@athlya.app, voir `SECURITY.md`)
