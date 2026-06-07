## Résumé

Event types non reconnus dans `handleEventsBatch` tombent dans `default → msg.ack()` sans traitement ni alerte (`worker.ts:1523-1526`).

**Finding audit** : C5 — gravité **Medium**, priorité **P2**.

## Comportement observé

Typo `event.type`, nouveau consumer oublié → **perte silencieuse** de messages. Outbox drain publie, queue avale.

## Solution proposée

1. `default` branch : `msg.retry()` ou redirect DLQ avec reason `unknown_event_type`
2. Métrique `queue_unknown_event_total{ type }`
3. Alerte Axiom si > 0 / 5min
4. Liste `HANDLED_EVENT_TYPES` partagée notifications + tests

## Critères d'acceptation

- [ ] Unknown type n'est plus ack silencieux
- [ ] Métrique + alerte
- [ ] Test unitaire default branch
- [ ] Doc event-bus mise à jour

## Références

- `packages/api/src/worker.ts` ~1523
- Audit prod 2026-05-27 — C5

## Priorité

**P2** — data loss silencieuse
