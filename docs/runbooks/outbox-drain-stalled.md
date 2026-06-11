# Runbook — Outbox drain stalled or erroring (issue #229)

## Symptoms

- `athlya.outbox.drain_errors` appears in Axiom logs (metric `outbox_drain_errors`, `failed > 0`).
- `outbox.backlog` reports growing `pending` count over successive cron ticks.
- BetterStack P1 fires on `backlogAlertRecommended: true` sustained for > 5 minutes.
- Queue consumer DLQ accumulates entries.

## Quick triage

```bash
# 1. Current backlog
curl -s -H "Authorization: Bearer $ADMIN_JWT" \
  https://api.athlya.app/admin/outbox/stats | jq '{pending, backlogAlertRecommended}'

# 2. Drain error rate (last 15 min)
# Axiom query:
# ['athlya-logs'] | where ['message'] == "athlya.outbox.drain_errors" | summarize sum(toint(['failed'])) by bin(_time, 1m)

# 3. Last successful drain
# ['athlya-logs'] | where ['message'] == "outbox.backlog" | sort by _time desc | take 5
```

## Diagnosis flow

### A. Cron trigger not firing

Check the Cloudflare dashboard → Workers & Pages → `api` → Triggers.
Verify the `* * * * *` cron is present and last-fired timestamp is recent.

If missing: re-add via `wrangler.toml` `[triggers]` block and `wrangler deploy`.

### B. Queue producer unreachable

`failed > 0` with `succeeded = 0` usually means the Cloudflare Queue binding
is misconfigured or the queue is full.

```bash
# Check queue stats in Cloudflare dashboard:
# Workers & Pages → Queues → EVENTS_QUEUE / EVENTS_NOTIFICATIONS_QUEUE / EVENTS_RGPD_QUEUE

# Verify wrangler bindings are present:
wrangler queues list
```

If a queue is full (backpressure): the worker's send call throws — rows stay
in the outbox and `failed` increments each cycle. Drain the consumer or
increase the queue throughput limit.

### C. Database unreachable (Neon cold-resume timeout)

`drainOutbox` wraps each claim/publish in `withConnectionRetry` (3 attempts,
exponential back-off). If all retries exhaust, the transaction rolls back and
`scheduled` catches the error via `.catch`, logging to `console.error`.

Axiom query to confirm:

```
['athlya-logs'] | where ['message'] contains "scheduled invocation failed"
```

Check Neon dashboard for compute suspension or connection quota exhaustion.
A free-tier branch auto-suspends after 5 min idle; the first drain tick after
suspension may fail once before the retry succeeds.

### D. Individual row stuck (poison-pill event)

A single outbox row can loop indefinitely if its `payload` is malformed and
the queue consumer keeps NACKing it. The `attempts` column tracks retry count.

```sql
-- Find high-attempt rows (run on Neon branch)
SELECT id, event_type, attempts, occurred_at
FROM outbox
WHERE published_at IS NULL
ORDER BY attempts DESC
LIMIT 20;
```

If a row has `attempts >= 5` and a valid `published_at IS NULL`, it is not
being published. Inspect the consumer logs for the matching `event.id`.

To unblock the drain without losing the event:

1. Manually publish the event (copy payload, send via admin script).
2. Mark the row as published:
   ```sql
   UPDATE outbox SET published_at = NOW() WHERE id = '<row-id>';
   ```

### E. DLQ accumulation

If the consumer NACK-loops an event into the DLQ, the outbox row itself is
already marked `published_at = NOW()` (the drain considers send-success
sufficient). The DLQ entry is a separate concern handled in
`docs/runbooks/event-bus.md`.

## Recovery

| Situation                        | Action                                                             |
| -------------------------------- | ------------------------------------------------------------------ |
| Backlog < 1 000, drain healthy   | Wait 1–2 cron cycles; verify `pending` decreases                   |
| Backlog > 1 000, drain healthy   | `ADAPTIVE_BATCH_SIZE = 200` — recovery takes `ceil(N/200)` minutes |
| Drain erroring every cycle       | Fix root cause (A–D above), then verify `drain_errors` drops to 0  |
| Poison-pill row blocking a shard | Mark row published manually (step D above)                         |
| Cron missing                     | Re-deploy via `wrangler deploy` with correct `[triggers]`          |

## Escalation

- P1 (backlog > 500 for > 5 min): page on-call via BetterStack alert A16.
- P2 (drain_errors > 10 in 5 min window): Axiom alert → Slack `#ops-alerts`.
- Database outage: follow `docs/runbooks/db-role-switch.md`.

## Related

- `packages/api/src/events/drain-scheduled.ts` — `emitOutboxDrainErrorsMetric`, `runScheduledDrain`
- `packages/api/src/events/drain-worker.ts` — `drainOutbox`, `DrainResult`
- `docs/runbooks/outbox-ops.md` — cadence, SLO, Axiom queries
- `docs/runbooks/event-bus.md` — queue consumer DLQ handling
- `docs/operations/axiom-alerts.md` — alert A16
