## Résumé

Le dispatcher `handleEventsBatch` dans `packages/api/src/worker.ts` ack silencieusement tous les event types autres que `auth.user.deleted` et `members.export.requested`. Le package `@athlya/notifications` expose un `handleEvent` complet (testé à 58 tests) mais **n'est jamais appelé en runtime**.

## Comportement attendu

Après drain outbox → Cloudflare Queue, les events `reservation.created`, `reservation.reminder`, `reservation.cancelled`, `reservation.promoted`, `billing.subscription.failed` etc. doivent être routés vers `@athlya/notifications/consumer` → Resend (email) + Expo Push.

## Comportement observé

```typescript
// packages/api/src/worker.ts — branche default
default: {
  msg.ack(); // message perdu, aucune notification envoyée
}
```

## Impact

- **Sévérité audit** : Critical / P0 production-blocker
- Confirmation email/push après booking : **jamais envoyée**
- Rappels cours, promotions waitlist, échecs billing : **silence total**
- Outbox + drain fonctionnent → l'incident est **invisible** sans vérif Resend/Expo dashboards

## Solution proposée

### 1. Router les event types dans `handleEventsBatch`

```typescript
import { handleEvent } from '@athlya/notifications/consumer';
import { buildNotificationDeps } from './adapters/notification-deps.js'; // à créer

case 'reservation.created':
case 'reservation.reminder':
// ... autres types supportés par consumer.ts
  await handleEvent(msg.body as AthlyaEvent, buildNotificationDeps(env));
  msg.ack();
  break;
```

### 2. Adapter `buildNotificationDeps(env)`

Wirer : Resend (`RESEND_API_KEY`, `RESEND_FROM`), Expo push tokens repo, dedup Redis, consent gating — mirror pattern `buildCascadeDeps` / `buildExportDeps`.

### 3. Gestion erreurs

- Erreur transient (Resend 5xx) → `msg.retry()` (budget `max_retries=5` wrangler.toml)
- Erreur permanente (recipient inconnu) → ack + log warn (déjà géré dans consumer)

### 4. Tests

- Étendre `packages/api/src/__tests__/queue-cascade.test.ts` avec cas `reservation.created` → assert `handleEvent` appelé
- Test intégration : book → outbox drain → queue → notification deps mock

## Composants touchés

- [x] `@athlya/api` (`worker.ts`, nouvel adapter)
- [x] `@athlya/notifications`
- [ ] `@athlya/db` — non
- [ ] Migration — non

## Critères d'acceptation

- [ ] `reservation.created` déclenche email + push (mock Resend/Expo en test)
- [ ] Types inconnus restent ack sans retry infini
- [ ] DLQ reçoit les messages après 5 retries sur erreur transient
- [ ] Runbook `docs/runbooks/event-bus.md` mis à jour
- [ ] `pnpm --filter @athlya/api test` vert (+ cas queue)

## Références

- `packages/notifications/src/consumer.ts` — matrice event types L331+
- Audit infra 2026-05-27 — finding #1 Critical
- Epic 9 / task 9.5 notifications consumer

## Priorité

**P0** — bloquant prod fonctionnelle (feature core invisible aux utilisateurs)
