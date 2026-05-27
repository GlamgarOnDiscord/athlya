---
name: Feature / Slice
about: Nouvelle fonctionnalité ou slice d'implémentation
title: 'feat: '
labels: enhancement, triage
assignees: ''
---

## Contexte

<!-- Pourquoi cette feature ? Quel besoin utilisateur ou technique elle adresse. -->

## Ce qu'il faut faire

<!-- Description précise et actionnable. Plus c'est détaillé, plus l'implémentation sera rapide. -->

## Packages touchés

- [ ] `@athlya/api` — routes, adapters, middleware
- [ ] `@athlya/auth`
- [ ] `@athlya/db` — schéma, migrations, RLS
- [ ] `@athlya/members`
- [ ] `@athlya/reservations`
- [ ] `@athlya/billing`
- [ ] `@athlya/notifications`
- [ ] `@athlya/shared` — schemas Zod, i18n
- [ ] `apps/web`
- [ ] `apps/studio`
- [ ] CI / infra

## Contraintes techniques

<!-- Conventions à respecter, invariants à ne pas casser, SLO, breaking changes. -->

- Breaking change API : oui / non
- Migration DB requise : oui / non
- Invariants impactés (P1–P8) :

## Definition of done

- [ ]
- [ ]
- [ ] Tests ajoutés (unit / integration / E2E selon le scope)
- [ ] Prettier + lint + typecheck verts
- [ ] PROGRESS.md + tasks.md mis à jour
