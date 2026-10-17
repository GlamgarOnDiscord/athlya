# Runbook — Outbox drain & alerting (issue #72)

## Cadence

- Cloudflare Cron minimum: **1 minute** (`* * * * *` in `wrangler.toml`).
- Design target was 30s; consumer dedup on `event.id` (24h) absorbs duplicates.
- Per-cycle batch: **100** rows; **200** when `pending > 500` (`OUTBOX_BACKLOG_BATCH_THRESHOLD`).
- Empty batch → early return (pas de send). La taille adaptative + le batch large suffisent à throttler ; un vrai skip "N cycles vides" exigerait un état (KV/Redis) et est différé.

## Roles and bindings (issue #497)

| Side     | Role          | Binding       | Allowed on `outbox`                                                              |
| -------- | ------------- | ------------- | -------------------------------------------------------------------------------- |
| Producer | `athlya_app`  | `DB_URL`      | `INSERT` for its own studio only (`app.studio_id`), undelivered rows only (0031) |
| Drainer  | `athlya_cron` | `CRON_DB_URL` | `SELECT`, `UPDATE (attempts, published_at)`, `DELETE` (0019 + 0031)              |

- Events are inserted in the same transaction as the mutation that emits
  them (`withTenant`), so a booking/cancel and its event commit or roll back
  together.
- The cron drain builds its connection from `CRON_DB_URL`. In staging and
  production a missing `CRON_DB_URL` skips the drain and logs
  `[worker] CRON_DB_URL missing — outbox drain skipped`
  (`code: configuration_error`); dev falls back to `DB_URL`.
- Each `queue.send` has a 5 s deadline: a hung queue call fails the row
  (retried next tick) instead of holding the claim transaction open.

## Overlap guard (issue #134)

- Le drain tourne dans **une transaction** avec `SELECT … FOR UPDATE SKIP LOCKED` : deux cycles qui se chevauchent ne traitent jamais la même ligne → overlap **correct par construction**.
- Pas de lock distribué : on émet `outbox.drain_overlap_risk` (`metric: outbox_drain_duration_ms`) quand un cycle dépasse `OUTBOX_DRAIN_OVERLAP_WARN_MS = 45_000` ms. C'est un **signal de charge**, pas une erreur.
- Si l'overlap est récurrent : passer le cron à 30s (`*/30 * * * * *` non supporté — utiliser deux triggers ou un Durable Object) ou augmenter `ADAPTIVE_BATCH_SIZE` après vérif du budget CPU Worker.

## SLO

| Metric                               | Target                                                            |
| ------------------------------------ | ----------------------------------------------------------------- |
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

Drain errors counter (**émis à chaque cycle avec `failed > 0`**, indépendant du logger — issue #229) :

```
['athlya-logs'] | where ['message'] == "athlya.outbox.drain_errors"
```

Drain completion (failures, via logger):

```
['drain'] | where message == "outbox drain: batch complete" and failed > 0
```

Backlog snapshot (**émis à chaque cron tick**, indépendant du logger — issue #134) :

```
['athlya-logs'] | where ['message'] == "outbox.backlog" and toint(['pending']) > 500
```

Overlap risk (cycle > 45s) :

```
['athlya-logs'] | where ['message'] == "outbox.drain_overlap_risk"
```

Voir `docs/operations/axiom-queries.md` § Outbox backlog et alerte **A16**.

### BetterStack / uptime

- Alert **P1** if `GET /admin/outbox/stats` reports `backlogAlertRecommended: true` for **> 5 minutes** (synthetic check or scheduled `curl`).
- Secondary: Axiom alert on `athlya.outbox.drain_errors` (`drain_errors > 10` in 5-minute window) — see `docs/runbooks/outbox-drain-stalled.md`.

## Load test (backlog recovery)

1. Insert N pending outbox rows (staging Neon branch).
2. Confirm `pending` drops below threshold within `ceil(N / 200)` minutes under steady cron.
3. Verify notifications consumer processes replayed events (issue #60).

## Related

- `packages/api/src/events/drain-scheduled.ts` — adaptive batch + backlog metric (`outbox.backlog`) + overlap guard (`outbox.drain_overlap_risk`) + drain errors counter (`athlya.outbox.drain_errors`)
- `docs/runbooks/outbox-drain-stalled.md` — diagnosis & recovery for stalled/erroring drain
- `packages/api/src/admin/outbox-routes.ts` — admin stats
- `docs/operations/axiom-alerts.md` — alerte **A16**
- `scripts/verify-outbox-drain-checklist.mjs` — checklist ops #134
- `docs/runbooks/preview-pr.md` — preview env (shared queues)
