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
   (`lease_until = NULL`).
3. **Mark** — delivered rows are stamped in one `UPDATE … WHERE id = ANY(…)`
   (`published_at = now()`, lease cleared).

Failure modes: a failed send keeps its lease → natural 2 min back-off; a dead
drain (isolate killed) loses nothing — rows come back when the lease lapses;
a failed final stamp means those rows are re-sent after the lease (consumers
dedup on `event.id`). Invariant (unit-tested): lease > deadline + one send
timeout + mark.

Capacity per batch: ≤ 200 rows; with a queue at 10 ms/send ≈ 0.25 s, at
1 s/send ≈ 25 s, fully hung queue → cut at 40 s with the connection idle. A
cycle chains up to `DRAIN_MAX_ROUNDS` batches (≤ 10 000 rows, see below).

## Throughput and fairness (issue #311)

- A cycle keeps claiming batches until the backlog is empty, the 40 s
  deadline is reached, or a whole batch failed (dead queue → stop, no spin).
  Cap: `DRAIN_MAX_ROUNDS = 50` batches per cycle.
- **Fairness**: `COMPLIANCE_EVENT_TYPES` (`auth.user.deleted`,
  `members.export.requested`, `auth.user.registered`,
  `billing.subscription.started`, `billing.subscription.failed`)
  are claimed before any other pending row, so a notification burst cannot
  starve RGPD / account / billing events.
- **Per-lane metric** every tick, before the drain: `outbox.lane_backlog`
  (`lane`, `pending`, `oldestAgeMs`). Every lane (`notifications`, `rgpd`,
  `legacy`) is reported, with `pending: 0` once drained.

Capacity model (pool 8, one tick = 40 s of sending then ~20 s idle until the
next one-minute tick):

| Queue latency / send | Service rate | 10k burst time-to-empty |
| -------------------- | ------------ | ----------------------- |
| 10 ms                | ~800 ev/s    | ~13 s (1 tick)          |
| 50 ms                | ~160 ev/s    | ~83 s (2 ticks)         |
| 200 ms               | ~40 ev/s     | ~6 min 10 s (7 ticks)   |

At 100 users the modeled peak is < 1 ev/s, at 10k users ~10 ev/s, at 1M
users ~1 000 ev/s (bursts at class start): beyond ~50 ms/send at 1M users
the cron drain is no longer enough and the direct publish (fast path) must
carry the load, the outbox staying the reconciliation path.

Alerts to configure (Axiom):

```
['athlya-logs'] | where ['message'] == "outbox.lane_backlog" and toint(['oldestAgeMs']) > 120000
['athlya-logs'] | where ['message'] == "outbox.drain_cycle" and toint(['rounds']) >= 50
```

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

On a **staging Neon branch** (never production), as the migration role:

Rows must be valid events (UUID `event_id`, full `reservation.reminder`
payload), otherwise the consumer rejects them and `pending = 0` proves
nothing. The fixed load `userId` matches no account, so no email is sent and
the rows are easy to clean up:

```sql
INSERT INTO outbox (event_id, event_type, payload, occurred_at, studio_id)
SELECT gen_random_uuid()::text, 'reservation.reminder',
       jsonb_build_object(
         'reservationId', gen_random_uuid(),
         'classId', gen_random_uuid(),
         'userId', '03110000-0000-4000-8000-000000000001',
         'startsAt', to_char((now() + interval '1 hour') AT TIME ZONE 'UTC',
                             'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
       now(), (SELECT id FROM studios LIMIT 1)
  FROM generate_series(1, 10000) g;
```

1. Record the time, then watch `outbox.drain_cycle` (`succeeded`, `durationMs`,
   `throughputPerSec`). `outbox.lane_backlog` is emitted before each drain, so
   confirm completion with `GET /admin/outbox/stats` (`pending = 0`) after the
   final cycle. Delivery shows up as one `notifications.skipped_no_recipient`
   per row; any `[worker] notifications event malformed, acking` means the
   fixture is wrong.
2. Insert one `auth.user.deleted` row mid-burst and check it is delivered on the
   next tick (fairness).
3. Pass: time-to-empty ≤ 2 min (SLO) at the measured queue latency; otherwise
   record the measured service rate and raise the pool size / add a tick.
4. Clean up:
   `DELETE FROM outbox WHERE event_type = 'reservation.reminder' AND payload->>'userId' = '03110000-0000-4000-8000-000000000001';`

## Related

- `packages/api/src/events/drain-scheduled.ts` — adaptive batch + backlog metric (`outbox.backlog`) + overlap guard (`outbox.drain_overlap_risk`) + drain errors counter (`athlya.outbox.drain_errors`)
- `docs/runbooks/outbox-drain-stalled.md` — diagnosis & recovery for stalled/erroring drain
- `packages/api/src/admin/outbox-routes.ts` — admin stats
- `docs/operations/axiom-alerts.md` — alerte **A16**
- `scripts/verify-outbox-drain-checklist.mjs` — checklist ops #134
- `docs/runbooks/preview-pr.md` — preview env (shared queues)
