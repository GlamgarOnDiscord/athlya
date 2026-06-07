## Résumé

Un seul topic queue `athlya-events` pour tous event types (auth, members, reservations, billing futur). Consumer dispatcher séquentiel dans `handleEventsBatch`. Types inconnus ack silencieux.

## Risques

- Consumer lent (export RGPD ZIP) retarde traitement autres messages **dans même batch CF** (parallelisme limité)
- Pas d'isolation blast radius par domaine
- Poison message type X affecte throughput global

## Solution proposée

### Topology cible

| Queue                         | Events                               | Consumer      |
| ----------------------------- | ------------------------------------ | ------------- |
| `athlya-events-notifications` | reservation._, billing._             | notifications |
| `athlya-events-rgpd`          | auth.user.deleted, members.export.\* | members       |
| `athlya-events-billing`       | billing.webhook.\*                   | billing       |

Outbox drain route par `event_type` prefix.

### Migration

1. Dual-write period (publish old + new queue)
2. Drain old queue empty
3. Remove old binding

## Critères d'acceptation

- [ ] ADR topology dans `docs/runbooks/event-bus.md`
- [ ] wrangler.toml queues par env
- [ ] Tests dispatch par queue
- [ ] Pas de duplicate processing (dedup event.id)

## Priorité

**P2** — quand volume > 1000 events/jour ou latency SLA notifications

## Dépendances

- Prérequis : #1 notifications consumer branché
