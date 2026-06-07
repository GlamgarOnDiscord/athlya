## Résumé

`ClassCapacityDO` : WebSocket par cours pour live capacity. OK petit scale. **Hot class** (50+ connexions) = charge sur un seul DO, limite CF.

**Finding audit** : P6 — gravité **Low–Medium**, priorité **P3**.

## Solution proposée

1. Benchmark DO sous N connexions simultanées
2. Seuil documenté (ex. >30 WS → fallback polling)
3. Option sharding DO par tranche ou SSE agrégé studio-wide

## Critères d'acceptation

- [ ] Limite documentée
- [ ] Fallback si DO saturé
- [ ] Test charge staging hot class

## Références

- Durable Objects capacity WS
- Audit prod 2026-05-27 — P6

## Priorité

**P3**
