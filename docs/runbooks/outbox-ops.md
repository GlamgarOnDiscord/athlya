# Runbook — Outbox drain & alerting (issue #72)

## Cadence

- Cloudflare Cron minimum: **1 minute** (`* * * * *` in `wrangler.toml`).
- Design target was 30s; consumer dedup on `event.id` (24h) absorbs duplicates.
- Per-cycle batch: **100** rows; **200** when `pending > 500` (`OUTBOX_BACKLOG_BATCH_THRESHOLD`).
- Empty batch → early return (pas de send). La taille adaptative + le batch large suffisent à throttler ; un vrai skip "N cycles vides" exigerait un état (KV/Redis) et est différé.

## Roles and bindings (issue #497)

| Side     | Role          | Binding       | Allowed on `outbox`                                                                     |
| -------- | ------------- | ------------- | --------------------------------------------------------------------------------------- |
| Producer | `athlya_app`  | `DB_URL`      | `INSERT` for its own studio only (`app.studio_id`), undelivered rows only (0031)        |
| Drainer  | `athlya_cron` | `CRON_DB_URL` | `SELECT`, `UPDATE (attempts, published_at, lease_until)`, `DELETE` (0019 + 0031 + 0035) |

- Events are inserted in the same transaction as the mutation that emits
  them (`withTenant`), so a booking/cancel and its event commit or roll back
  together.
- The cron drain builds its connection from `CRON_DB_URL`. In staging and
  production a missing `CRON_DB_URL` skips the drain and logs
  `[worker] CRON_DB_URL missing — outbox drain skipped`
  (`code: configuration_error`); dev falls back to `DB_URL`.
- Each `queue.send` has a 5 s deadline: a hung queue call fails the row
  (retried once its lease lapses).

## Leased drain (issue #424)

No transaction and no row lock are held while sending:

1. **Claim** — one autocommit statement: `FOR UPDATE SKIP LOCKED` on pending
   rows whose `lease_until` is NULL or past, `attempts + 1`,
   `lease_until = now() + 120 s` (`DRAIN_LEASE_SECONDS`). Locks are released
   when the statement commits.
2. **Send** — outside any transaction, pool of `DRAIN_SEND_CONCURRENCY = 8`,
   each send bounded by 5 s. No new send starts after
   `DRAIN_CYCLE_DEADLINE_MS = 40 s`; unattempted rows are released
   (`lease_until = NULL`, claim attempt undone, fenced on the claim's lease)
   and reported as `released` in `outbox.drain_cycle`, not as failures.
3. **Mark** — delivered rows are stamped in one `UPDATE … WHERE id = ANY(…)`
   (`published_at = now()`, lease cleared).

Failure modes: a failed send keeps its lease → natural 2 min back-off; a dead
drain (isolate killed) loses nothing — rows come back when the lease lapses;
a failed final stamp means those rows are re-sent after the lease (consumers
dedup on `event.id`). Invariant (unit-tested): lease > deadline + one send
timeout + mark.

Canary: an old Worker's lease-unaware claim is skipped by the
`outbox_skip_leased_claim` trigger on rows under a live lease (0035), so
old and new drainers never send the same row while both run.

Capacity per cycle (one cron tick): ≤ 200 rows; with a queue at 10 ms/send
≈ 0.25 s, at 1 s/send ≈ 25 s, fully hung queue → cut at 40 s with the
connection idle. Scaling beyond 200 rows/min is issue #311.

## Overlap guard (issue #134)

- Le claim pose un **lease** (`lease_until`) : deux cycles qui se chevauchent ne traitent jamais la même ligne tant que le lease court → overlap **correct par construction** (issue #424).
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

Cycle metric (**every cycle**, issue #424 — duration, throughput, failures):

```
['athlya-logs'] | where ['message'] == "outbox.drain_cycle" | summarize p95(toint(['durationMs'])), sum(toint(['failed'])) by bin(_time, 5m)
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
