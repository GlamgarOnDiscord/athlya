## Résumé

Compteur capacité cours = Redis DECR + Postgres FOR UPDATE. Crash Worker / bug → **drift Redis↔PG** (surbooking ou faux "complet").

**Finding audit** : P5 — gravité **Medium**, priorité **P2**.

## Solution proposée

1. Cron réconciliation : `COUNT(confirmed)` PG vs Redis key par classe active
2. Métrique `capacity_redis_pg_drift{ class_id }`
3. Auto-heal : reset Redis from PG si drift > 0
4. Alerte drift > 0 persistant 5min

## Composants

- [ ] `packages/reservations/` — job reconcile
- [ ] Cron worker ou scheduled
- [ ] Tests drift scenario

## Critères d'acceptation

- [ ] Job reconcile staging testé
- [ ] Métrique + alerte
- [ ] Runbook incident drift

## Références

- `packages/reservations/src/book.ts`
- Audit prod 2026-05-27 — P5

## Priorité

**P2**
