---
name: Proposition de fonctionnalité
about: Suggérer une nouvelle fonctionnalité ou amélioration
title: '[feat] '
labels: enhancement, triage
assignees: ''
---

## Problème adressé

<!-- Quel besoin utilisateur / opérateur cette fonctionnalité résout-elle ?
     Éviter "il serait bien d'avoir X" ; préférer "en tant que [rôle],
     je veux [comportement], afin de [bénéfice]". -->

## Solution proposée

<!-- Description technique. Si plusieurs options, les lister avec leurs tradeoffs. -->

## Lien avec la roadmap

<!-- Vérifier si la fonctionnalité relève déjà d'une tâche planifiée.
     Voir .kiro/specs/athlya-platform/tasks.md et PROGRESS.md. -->

- [ ] Nouvelle tâche (pas dans `tasks.md`)
- [ ] Raffinement d'une tâche existante : Epic X.Y
- [ ] Relève d'un épic non encore démarré : Epic N

## Alternatives considérées

<!-- Autres approches envisagées et raisons de les écarter. -->

## Impact

### Composants touchés

- [ ] `@athlya/api` (gateway, middleware)
- [ ] `@athlya/auth`
- [ ] `@athlya/db` (schéma, RLS, migrations)
- [ ] `@athlya/reservations`
- [ ] `@athlya/members`
- [ ] `@athlya/billing`
- [ ] `@athlya/notifications`
- [ ] `@athlya/shared` (schémas Zod, i18n, tokens)
- [ ] Applications clientes (`apps/web`, `apps/mobile`, `apps/studio-admin`)
- [ ] CI / Infra
- [ ] Documentation / specs

### Breaking change

- [ ] Oui — contrats API modifiés
- [ ] Oui — schéma DB modifié (migration requise)
- [ ] Non

### Invariants formels

<!-- Cocher si la proposition modifie un invariant existant (P1 à P8, round-trip). -->

- [ ] Impact potentiel sur un invariant — lequel :
- [ ] Aucun impact sur les invariants existants

### SLO

<!-- La proposition modifie-t-elle les cibles p99 < 500 ms, 99.9 % availability,
     zéro double-booking ? -->

## Priorité suggérée

- [ ] Bloquant v0.1 MVP
- [ ] Souhaitable v0.1
- [ ] v0.2 ou plus tard
- [ ] Nice-to-have sans urgence

## Mesure de succès

<!-- Comment saura-t-on que la fonctionnalité est correctement livrée ?
     Tests, métriques observables, retour utilisateur, etc. -->

## Checklist

- [ ] J'ai vérifié que la fonctionnalité n'est pas déjà planifiée dans `tasks.md`
- [ ] J'ai vérifié que la proposition ne contredit pas les requirements existants
- [ ] J'ai lu `CONTRIBUTING.md` pour comprendre le workflow
