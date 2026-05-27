# Runbook — Outbox drain & alerting (issue #72)

## Cadence

- Cloudflare Cron minimum: **1 minute** (`* * * * *` in `wrangler.toml`).
- Design target was 30s; consumer dedup on `event.id` (24h) absorbs duplicates.
- Per-cycle batch: **100** rows; **200** when `pending > 500`.

## SLO

| Metric | Target |
|--------|--------|
| Domain event → notification delivery | **p95 < 2 min** (`OUTBOX_EVENT_TO_NOTIFICATION_P95_MS = 120_000`) |

Cron granularity + queue consumer latency dominate tail latency; alert on backlog, not only on cron tick.

## Observability

### Admin API

```bash
curl -s -H "Authorization: Bearer $ADMIN_JWT" \
  https://api.athlya.app/admin/outbox/stats | jq .
```

Response fields:

- `pending` — `COUNT(*)` where `published_at IS NULL`
- `oldestPendingOccurredAt` — `MIN(occurred_at)` for backlog age
- `backlogAlertRecommended` — `true` when `pending > 500`

### Axiom queries

Drain completion (failures):

```
['drain'] | where message == "outbox drain: batch complete" and failed > 0
```

Backlog snapshot (each cron tick when logger is wired):

```
['drain'] | where message == "outbox drain: pending snapshot" and pending > 500
```

### BetterStack / uptime

- Alert **P1** if `GET /admin/outbox/stats` reports `backlogAlertRecommended: true` for **> 5 minutes** (synthetic check or scheduled `curl`).
- Secondary: Axiom alert on `failed > 0` in batch complete logs.

## Load test (backlog recovery)

1. Insert N pending outbox rows (staging Neon branch).
2. Confirm `pending` drops below threshold within `ceil(N / 200)` minutes under steady cron.
3. Verify notifications consumer processes replayed events (issue #60).

## Related

- `packages/api/src/events/drain-scheduled.ts` — adaptive batch + pending snapshot log
- `packages/api/src/admin/outbox-routes.ts` — admin stats
- `docs/runbooks/preview-pr.md` — preview env (shared queues)
