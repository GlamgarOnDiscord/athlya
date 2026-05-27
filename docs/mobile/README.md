# Mobile — Epic 10 / issue #70

**Statut** : post-1.0 (v1.1). Pas de `apps/mobile` en prod v0.1.

## Checklist (13 tâches — `tasks.md` § 11)

- [ ] 11.1 Scaffold Expo SDK 55 + NativeWind 4
- [ ] 11.2 `expo-secure-store` refresh token
- [ ] 11.3 Biometric unlock
- [ ] 11.4 API client + `Idempotency-Key`
- [ ] 11.5 `MutationQueue` MMKV
- [ ] 11.6 `drainMutationQueue` (Algorithm 4)
- [ ] 11.7 NetInfo auto-drain
- [ ] 11.8 Booking optimistic UI
- [ ] 11.9 QR check-in
- [ ] 11.10 Workout logging offline
- [ ] 11.11 RGPD export/delete
- [ ] 11.12 Property test offline drain
- [ ] 11.13 MutationQueue persistence tests

## Déclencheur business

Décision iOS/Android + studio pilote — voir [`docs/roadmap/post-1.0.md`](../roadmap/post-1.0.md).

## Compliance mobile

Expo Push SCC : [`docs/compliance/expo-push-transfers.md`](../compliance/expo-push-transfers.md) (#86).

## Prérequis techniques

- Compte EAS Build
- API staging stable + feature flags
