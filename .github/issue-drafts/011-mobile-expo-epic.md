## Problème adressé

Epic 11 — Application mobile Expo SDK 55 : **0/13 tâches livrées**. Aucun dossier `apps/mobile`. Pourtant le README et l'architecture promettent local-first 72h offline, MMKV queue, PBT P5 bloqué.

## Solution proposée

Epic complet selon `.kiro/specs/athlya-platform/tasks.md` Epic 11 :

1. Scaffold `apps/mobile` Expo SDK 55 + EAS
2. Auth refresh cookie-less (Bearer + secure storage)
3. Offline read cache 72h
4. Write queue MMKV + drain FIFO (PBT P5)
5. Push notifications Expo
6. Parité flows : login, classes list, book, cancel, profile

## Lien roadmap

- [x] Epic 11 — Mobile Expo (0/13)
- Bloque invariant P5 (offline drain FIFO)

## Composants touchés

- [ ] `apps/mobile` (nouveau)
- [x] `@athlya/shared` schémas
- [x] `@athlya/api` — CORS/mobile auth déjà apex host

## Critères d'acceptation

- [ ] App build EAS preview
- [ ] PBT P5 vert
- [ ] README architecture aligné (pas « prévu »)
- [ ] DPA Expo Push + SCC UE (issue séparée #27)

## Priorité

**P1** produit — post-MVP web si scope réduit acceptable

## Mesure de succès

Maestro/EAS Device Testing : login → book → offline 24h → sync
