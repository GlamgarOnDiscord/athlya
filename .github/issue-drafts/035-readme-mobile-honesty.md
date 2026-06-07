## Résumé

README, diagramme mermaid et marketing présentent **3 applications** (web, studio, **Expo mobile SDK 55**). `docs/mobile/README.md` : **0/13 tâches, pas de `apps/mobile`**. Promesse "72h offline" = fiction.

**Finding audit** : A3 — gravité **High**, priorité **P1**.

Issue #70 fermée avec doc tracking — **README principal toujours mensonger**.

## Comportement attendu

- README v1.0 = **backend + web + studio** explicitement
- Mobile = roadmap v1.1+ avec lien `docs/mobile/README.md`
- Diagramme architecture sans Expo dans le chemin critique v1.0

## Comportement observé

- README L~architecture : Expo SDK 55, offline-first
- Pas de dossier `apps/mobile`
- Décisions business/conformité push (Expo US) basées sur produit absent

## Solution proposée

1. README section Architecture : retirer mobile du diagramme principal
2. Ajouter encart "Mobile (v1.1 — non livré)" avec statut 0/13
3. CHANGELOG / marketing site alignés
4. `docs/compliance/expo-push-transfers.md` : marquer "applicable v1.1+"

## Critères d'acceptation

- [ ] README ne prétend pas mobile livré en v1.0
- [ ] Mermaid / diagrammes mis à jour
- [ ] Lien vers epic mobile doc
- [ ] Pas de régression liens internes docs

## Références

- `README.md`
- `docs/mobile/README.md`
- Audit prod 2026-05-27 — A3

## Priorité

**P1** — gouvernance produit + honnêteté stakeholders
