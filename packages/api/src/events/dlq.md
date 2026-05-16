# Event Bus Dead-Letter Queue (DLQ)

> Operational note for the `athlya-events-dlq` queue.
> Configured in `packages/api/wrangler.toml`. Satisfies Requirement 16.5.

## Topology

- **Primary queue**: `athlya-events` — single topic carrying every
  `AthlyaEvent` variant (reservation.\*, auth.\*, billing.\*, members.\*).
  Producer binding: `EVENTS_QUEUE`.
- **Dead-letter queue**: `athlya-events-dlq` — receives messages that
  the primary consumer fails to process **5 consecutive times**
  (`max_retries = 5` on the primary consumer).

Cloudflare Queues increments a per-message delivery counter on every
consumer rejection (thrown exception, or `msg.retry()` without `ack()`).
When the counter reaches `max_retries + 1` deliveries without an ack,
the message is moved to the configured `dead_letter_queue`.

## Retry budget rationale

Five retries is the design default called out in Requirement 16.5 and
the design document's §E5 (event bus indisponible):

- Covers transient Redis/Neon blips (Upstash failover, Hyperdrive
  re-handshake) without prematurely DLQ'ing legitimate events.
- Bounded so a permanently poisoned message (schema-invalid envelope,
  consumer bug) does not retry forever and starve the queue.
- Combined with the 24 h `event.id` dedup key in Redis (Req 17.4),
  replays from retries are safe — consumers are idempotent.

## Monitoring expectations

DLQ depth is a **platform-level incident signal**. Any message landing
on `athlya-events-dlq` means we burned the full retry budget on the
primary consumer, which implies one of:

1. A consumer bug rejecting well-formed events.
2. A malformed envelope that passed `publish`'s `parseEvent` (shouldn't
   happen — `InvalidEventError` fails fast on the producer side) but
   trips a consumer's downstream validator.
3. A sustained downstream outage (Resend, Expo Push, Stripe) beyond
   the consumer's own retry budget.

### Alerting

- **Metric**: `queue.athlya-events-dlq.messages_pending` (Cloudflare
  Queues metrics, exported to Axiom via OTel — see Req 30.1, 30.2).
- **Threshold**: page on-call when `messages_pending > 0` for more
  than 5 minutes.
- **Severity**: SEV-3 at first message; escalate to SEV-2 if depth
  keeps growing for 30 minutes.

### Runbook (summary)

When a DLQ alert fires, ops should:

1. **Inspect** — `wrangler queues consumer athlya-events-dlq tail`
   (or read the replay tool in the admin studio app once it exists).
   Capture at least one message payload for triage.
2. **Classify** —
   - _Bad code_ → roll back the offending consumer deploy, then
     replay from DLQ once fixed.
   - _Bad event_ → patch the producer, drop the poisoned message
     from DLQ explicitly (record the drop in the audit log; these
     are platform actions, not tenant actions).
   - _Downstream outage_ → keep messages in DLQ until the downstream
     recovers, then replay in FIFO order.
3. **Replay** — use the DLQ consumer handler (tracked separately) to
   re-publish into `athlya-events` once the root cause is fixed.
   Consumers dedup on `event.id` (Req 17.4), so double-delivery is
   safe within the 24 h window.
4. **Post-mortem** — any SEV ≥ 3 DLQ incident triggers a lightweight
   post-mortem per Req 24/30 SLO commitments.

## Non-goals of this document

- The DLQ **handler/consumer implementation** is out of scope for task
  9.4 — only the queue declaration is. The handler lands in a later
  task alongside the Notifications consumer wiring (task 9.5) and the
  admin replay tooling.
- The **outbox drain worker** (task 9.3) is a separate recovery path
  and does not interact with this DLQ: it republishes from the
  PostgreSQL `outbox` table directly onto `athlya-events`, where the
  normal retry budget applies again.
