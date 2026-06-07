## Résumé

Outbox drain : cron **1 min** (min CF) vs 30s design. Batch 100 rows. Combiné au consumer notifications non branché (#1), les events peuvent être **drainés puis ackés sans effet**.

## Comportement observé

- `wrangler.toml` `crons = ["* * * * *"]`
- `drain-scheduled.ts` — claimBatch FOR UPDATE SKIP LOCKED
- Latence event → queue : jusqu'à 60s + processing

## Impact

- **Sévérité** : High / P1 (après fix notifications)
- Notifications booking retard 1-2 min minimum
- Backlog outbox spike → delay cascade

## Solution proposée

### 1. Alerting backlog

Axiom query :

```
[drain] batch complete AND failed > 0
OR outbox pending count > threshold
```

SQL metric : `SELECT COUNT(*) FROM outbox WHERE published_at IS NULL`

### 2. Augmenter fréquence si possible

Cloudflare Cron min = 1 min — acceptable si documenté. Alternative : QStash scheduled HTTP ping `/internal/drain` every 30s (coût).

### 3. Batch size adaptatif

Si pending > 500 → batch 200 (cap CPU Worker 30s)

### 4. Dashboard ops

Endpoint admin `GET /admin/outbox/stats` (admin-only) — mirror DLQ pattern

## Critères d'acceptation

- [ ] Alerte si outbox pending > N pendant > 5 min
- [ ] SLO documenté : event→notification p95 < 2 min
- [ ] Load test avec outbox backlog recovery

## Priorité

**P1** (dépend #1 notifications)

## Dépendances

- Bloqué par #1 (consumer notifications) pour valeur user-facing
