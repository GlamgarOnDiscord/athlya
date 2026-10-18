---
name: Bug
about: Comportement incorrect ou erreur
title: 'fix: '
labels: bug, triage
assignees: ''
---

## Résumé

<!-- Une phrase. -->

## Comportement attendu vs observé

|             |     |
| ----------- | --- |
| **Attendu** |     |
| **Observé** |     |

## Reproduction

**Package :** `@athlya/`
**Environnement :** dev / staging / production / CI
**Commit :** <!-- `git rev-parse --short HEAD` -->

Étapes :

1.
2.
3.

## Contexte technique

**Trace ID** (`x-trace-id`) :
**Status HTTP + body** :

```json

```

**Log Worker (Axiom / Wrangler Tail)** :

```json

```

## Impact

- [ ] Bloquant (pas de workaround)
- [ ] Dégradation (workaround existe)
- [ ] Cosmétique

## Packages touchés

- [ ] `@athlya/api`
- [ ] `@athlya/auth`
- [ ] `@athlya/db`
- [ ] `@athlya/members`
- [ ] `@athlya/reservations`
- [ ] `@athlya/programs`
- [ ] `@athlya/billing`
- [ ] `@athlya/notifications`
- [ ] `@athlya/shared`
- [ ] `apps/web`
- [ ] `apps/studio`

## Definition of done

- [ ] Bug non reproductible sur master
- [ ] Test de non-régression ajouté
- [ ] Pas de régression sur la suite existante
