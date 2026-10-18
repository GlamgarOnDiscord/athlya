# Runbook — Outbox drain & alerting (issue #72)

## Cadence

Two triggers run the same leased drain (`runScheduledDrain`):

- **Outbox kick (event-driven, issue #311)** — the fast path, described below.
- **Cron (safety net)** — Cloudflare Cron minimum: **1 minute**
  (`* * * * *` in `wrangler.toml`). It also emits the backlog metrics.

Consumer dedup on `event.id` (24h) absorbs duplicates.

Batch (one claim):

- **100** rows while `pending ≤ 500` (`OUTBOX_BACKLOG_BATCH_THRESHOLD`).
- **500** rows under backlog (`ADAPTIVE_BATCH_SIZE`), and on kick drains,
  which skip the pending snapshot.
- Override the backlog size with the `OUTBOX_DRAIN_BATCH_SIZE` var on the
  gateway (`[env.<env>.vars]` in `wrangler.toml`, or
  `wrangler deploy --var OUTBOX_DRAIN_BATCH_SIZE:<n>`). Bounds: 1 to
  `MAX_DRAIN_BATCH_SIZE = 1000` (the claim limit). A larger value is clamped.
  A value that is not a positive integer is ignored, with a
  `configuration_error` warning.

An empty batch returns early without sending.

## Outbox kick (issue #311)

Before the kick, a row that only reached the outbox waited for the next cron
tick: up to 60 s plus the cycle. That breaks the 30 s RGPD target. This
happens when the direct publish fails, and every time on the bulkhead Workers,
which have no lane queue bindings.

**Producer** (every Worker that writes outbox rows: gateway, auth,
reservations, billing):

1. Each writer calls `noteOutboxWrite(eventType)` after its outbox write.
   - `publish()` in transactional mode;
   - reservations book and cancel;
   - the RGPD export request;
   - `auth_record_event` and the user repo's register and delete;
   - `billing_apply_stripe_event`.

   The call only flags the request scope.

2. The `/v1/*` scope (`installDomainScope`) runs the handler. When the
   handler returns, the transaction has committed. If a row was flagged, the
   scope sends one `{ type: "outbox.kick", compliance }` message to
   `OUTBOX_KICK_QUEUE` through `ctx.waitUntil`, whatever the response status.
3. **Coalescing per isolate**: at most one kick per second
   (`OUTBOX_KICK_MIN_INTERVAL_MS`). A request inside the window arms a single
   trailing kick for the end of the window. So every committed row is still
   followed by a kick sent after its commit, and a burst of 1 000 writes in
   one isolate sends 2 kicks.
4. A failed send logs `outbox.kick_failed` and never fails the request. The
   cron drain delivers the rows.

**Consumer** (gateway only):

- The `athlya-outbox-kick*` consumer is configured with
  `max_batch_size = 100`, `max_batch_timeout = 1`, `max_concurrency = 1` and
  `max_retries = 2`, without a DLQ.
- Each batch runs **one** `runKickDrain`, as `athlya_cron`
  (`CRON_DB_URL`, exactly like the cron), whatever the number of kicks in it:
  - at most `KICK_DRAIN_MAX_ROUNDS = 10` batches;
  - within `KICK_DRAIN_DEADLINE_MS = 20 s`;
  - compliance types first in every round;
  - no pending snapshot.
- It logs `outbox.kick_drain` with `kicks`, `compliance`, `processed` and
  `succeeded`, and `outbox.drain_cycle` with `trigger: "kick"`.
- A drain that throws retries the batch after 5 s. Without `CRON_DB_URL`
  the kicks are acked; the cron already logs the configuration error.

**Concurrency**: kick drains never overlap each other (`max_concurrency = 1`).
A kick drain and the cron drain claim through the same leased statement, so a
row under a live lease is skipped and the two never send the same row. This is
tested on Postgres in `packages/db/tests/outbox-claim.pglite.test.ts`.

**RGPD latency budget**, from commit to `queue.send`:

| Step                                              | Bound                                       |
| ------------------------------------------------- | ------------------------------------------- |
| Kick sent (coalescer window)                      | ≤ 1 s                                       |
| Consumer batch timeout                            | ≤ 1 s                                       |
| Queue delivery to the consumer                    | platform latency (measure in the load test) |
| Kick drain already running: its next round claims | ≤ 1 round (500 rows ÷ 8 × send latency)     |
| Send                                              | ≤ 5 s deadline                              |

At 50 ms per send, a round is about 3 s, so the expected worst case stays
around 10 s plus the queue delivery latency, well under 30 s.

**Provisioning**: create the queue before deploying, or Wrangler refuses the
binding. `scripts/verify-secrets.mjs` fails the deploy gate when a queue that
a config binds is missing.

```bash
wrangler queues create athlya-outbox-kick            # dev + production
wrangler queues create athlya-outbox-kick-staging
```

Previews create `athlya-outbox-kick-preview-pr-<N>` per PR.

**Disable**: remove the `OUTBOX_KICK_QUEUE` producer bindings. The kick then
becomes a no-op, and the cron alone delivers.

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

Capacity per batch: ≤ 500 rows by default (≤ 1000 configured); with a queue
at 10 ms/send ≈ 0.6 s, at 1 s/send ≈ 63 s (cut at 40 s), fully hung queue →
cut at 40 s with the connection idle. A cycle chains up to `DRAIN_MAX_ROUNDS`
batches (≤ 25 000 rows by default, see below).

## Throughput and fairness (issue #311)

- A cycle keeps claiming batches until the backlog is empty, the 40 s
  deadline is reached (unsent rows are `released`), or a whole batch failed
  (dead queue → stop, no spin).
  Cap: `DRAIN_MAX_ROUNDS = 50` batches per cycle.
- **Fairness**: `COMPLIANCE_EVENT_TYPES` (`auth.user.deleted`,
  `members.export.requested`, `auth.user.registered`,
  `billing.subscription.started`, `billing.subscription.failed`)
  are claimed before any other pending row, so a notification burst cannot
  starve RGPD / account / billing events.
- **Per-lane metric** every tick, before the drain: `outbox.lane_backlog`
  (`lane`, `pending`, `oldestAgeMs`). Every lane (`notifications`, `rgpd`,
  `legacy`) is reported, with `pending: 0` once drained.

### Capacity model (issue #311)

**"500+ events per batch"**: the issue defines the old batch as "100
events per cron tick", so "batch" there means one drain cycle. Both
readings are met:

- the claim batch is **500** under backlog (configurable 1–1000);
- one cron cycle delivers up to `DRAIN_MAX_ROUNDS × batch` = **25 000**
  events (`drainCycleCapacity`).

`drain-scheduled-batch.test.ts` drains a 10 000-event backlog in one cycle
with 500-event batches (20 full claims plus the empty one).

Bounds per drain (pool `DRAIN_SEND_CONCURRENCY = 8`):

| Drain | Rounds × batch | Deadline | Max rows      | Duty cycle                                      |
| ----- | -------------- | -------- | ------------- | ----------------------------------------------- |
| Cron  | 50 × 500       | 40 s     | 25 000 / tick | 40 s of every 60 s                              |
| Kick  | 10 × 500       | 20 s     | 5 000 / kick  | back-to-back while kicks arrive (one at a time) |

Service rate = 8 ÷ send latency per drain, so cron + kick together are
2 × that while both run. Rows written by requests (the real case) are
drained by kicks.

10k burst time-to-empty:

| Queue latency / send | Rate per drain | Cron only (SQL insert, no kick) | Request-driven (kick + cron) |
| -------------------- | -------------- | ------------------------------- | ---------------------------- |
| 10 ms                | ~800 ev/s      | ~13 s (1 tick)                  | ~7–13 s                      |
| 50 ms                | ~160 ev/s      | ~83 s (2 ticks)                 | ~32–63 s                     |
| 200 ms               | ~40 ev/s       | ~6 min 10 s (7 ticks)           | ~2–4 min                     |

The 2 min target holds up to roughly 80 ms per send in the request-driven
case. These figures are a model from the code's bounds, not measurements.
The 10k load test below measures the send latency and fills in the real
numbers.

Platform limits to verify in the load test:

- Each `queue.send` is one binding call and counts toward the Workers
  per-invocation subrequest limit of the account's plan. A full cron cycle can
  issue 25 000 sends. If the plan's limit is lower, sends past it fail and the
  cycle stops on the first fully failed batch. Lower `OUTBOX_DRAIN_BATCH_SIZE`
  (a deploy var) to fit. Lowering `DRAIN_MAX_ROUNDS` is a code change: it is
  a constant in `drain-scheduled.ts`. Moving to `sendBatch` (100 messages per call)
  is the follow-up.
- Queue write throughput per queue.

Scale: at 100 users the modeled peak is < 1 ev/s, at 10k users ~10 ev/s, and
at 1M users ~1 000 ev/s (bursts at class start). Beyond ~50 ms/send at 1M
users, the drains are no longer enough on their own. The direct publish must
carry the load, and the outbox stays the reconciliation path.

Alerts to configure (Axiom):

```
['athlya-logs'] | where ['message'] == "outbox.lane_backlog" and toint(['oldestAgeMs']) > 120000
['athlya-logs'] | where ['message'] == "outbox.drain_cycle" and toint(['rounds']) >= 50
['athlya-logs'] | where ['message'] == "outbox.kick_failed" | summarize count() by bin(_time, 5m)
['athlya-logs'] | where ['message'] == "outbox.kick_drain_failed"
```

## Overlap guard (issue #134)

- Le claim pose un **lease** (`lease_until`) : deux cycles qui se chevauchent ne traitent jamais la même ligne tant que le lease court → overlap **correct par construction** (issue #424).
- Pas de lock distribué : on émet `outbox.drain_overlap_risk` (`metric: outbox_drain_duration_ms`) quand un cycle dépasse `OUTBOX_DRAIN_OVERLAP_WARN_MS = 45_000` ms. C'est un **signal de charge**, pas une erreur.
- Si l'overlap est récurrent : passer le cron à 30s (`*/30 * * * * *` non supporté — utiliser deux triggers ou un Durable Object) ou augmenter `ADAPTIVE_BATCH_SIZE` après vérif du budget CPU Worker.

## SLO

| Metric                               | Target                                                            |
| ------------------------------------ | ----------------------------------------------------------------- |
| Domain event → notification delivery | **p95 < 2 min** (`OUTBOX_EVENT_TO_NOTIFICATION_P95_MS = 120_000`) |

With the outbox kick, request-written rows no longer wait for the cron tick:
the kick path bounds tail latency, and the cron covers kicks that were lost.
Alert on backlog, not only on cron tick.

| Lane                                         | Target                                |
| -------------------------------------------- | ------------------------------------- |
| RGPD (`auth.user.deleted`, export requested) | queued within **30 s** of the request |
| 10k-event burst                              | time-to-empty **≤ 2 min** (load test) |

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
['athlya-logs'] | where ['message'] == "outbox.drain_cycle" | summarize percentile(toint(['durationMs']), 95), sum(toint(['processed'])), sum(toint(['failed'])), sum(toint(['released'])) by bin(_time, 5m)
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
nothing. The payload schema is strict, so the per-run marker is the `userId`
itself: a fresh UUID that matches no account (no email is sent) and that only
this run's rows carry. In `psql`:

```sql
SELECT gen_random_uuid() AS load_run_user \gset
\echo :load_run_user
INSERT INTO outbox (event_id, event_type, payload, occurred_at, studio_id)
SELECT gen_random_uuid()::text, 'reservation.reminder',
       jsonb_build_object(
         'reservationId', gen_random_uuid(),
         'classId', gen_random_uuid(),
         'userId', :'load_run_user',
         'startsAt', to_char((now() + interval '1 hour') AT TIME ZONE 'UTC',
                             'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
       now(), (SELECT id FROM studios LIMIT 1)
  FROM generate_series(1, 10000) g;
```

A bulk SQL insert produces no kick, so it measures the **cron-only** path.
To measure the kick path as well, send one request that writes an outbox
row right after the insert (for example, book and cancel a reservation in a
test studio). Its kick starts a kick drain, which takes up to 5 000 rows.
Further kicks come only from new requests.

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
   Record the measured send latency, `throughputPerSec` per trigger and any
   subrequest-limit error in the capacity model above.
4. RGPD lane: delete a test account (or request an export) during the burst
   and check that `auth.user.deleted` (or `members.export.requested`) reaches
   `queue.send` within 30 s of the request. Use the `outbox.kick_drain`
   timestamp and the RGPD consumer log.
5. Clean up only this run's rows, in the same `psql` session:
   `DELETE FROM outbox WHERE event_type = 'reservation.reminder' AND payload->>'userId' = :'load_run_user';`
   From another session, paste the UUID echoed above inside the quotes:
   `DELETE FROM outbox WHERE event_type = 'reservation.reminder' AND payload->>'userId' = 'PASTE_LOAD_RUN_USER_UUID';`

## Related

- `packages/api/src/events/outbox-kick.ts` — kick producer, coalescer and consumer (issue #311)
- `packages/api/src/events/drain-scheduled.ts` — adaptive batch + backlog metric (`outbox.backlog`) + overlap guard (`outbox.drain_overlap_risk`) + drain errors counter (`athlya.outbox.drain_errors`)
- `docs/runbooks/outbox-drain-stalled.md` — diagnosis & recovery for stalled/erroring drain
- `packages/api/src/admin/outbox-routes.ts` — admin stats
- `docs/operations/axiom-alerts.md` — alerte **A16**
- `scripts/verify-outbox-drain-checklist.mjs` — checklist ops #134
- `docs/runbooks/preview-pr.md` — preview env (shared queues)
