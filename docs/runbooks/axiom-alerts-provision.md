# Provisioning — 14 alertes Axiom (issues #120, #126)

**Owner:** SRE / on-call  
**Durée estimée:** ~3 h (Day 2 checklist)  
**Définitions APL:** [`docs/operations/axiom-alerts.md`](../operations/axiom-alerts.md) (A1–A14)

---

## SLO monitors managed as code (#415)

A1 (5xx rate), A2 (login p95), A3 (booking p99), A4 (queue lag), A5 (DLQ
depth) and A16 (outbox backlog) are provisioned by Terraform in
[`infra/terraform/axiom-monitors.tf`](../../infra/terraform/axiom-monitors.tf)
and applied per environment by `.github/workflows/terraform.yml`
(`TF_VAR_axiom_api_token` secret, `AXIOM_SPANS_DATASET` /
`AXIOM_LOGS_DATASET` / `AXIOM_NOTIFIER_IDS` variables; see
[`terraform-ops.md`](./terraform-ops.md)). Do not create them by hand: the
daily drift check flags any UI edit. If they already exist in the UI,
import them (`terraform import 'axiom_monitor.slo["<key>"]' <monitor-id>`)
or delete them before the first apply.

The queries read the signals the runtime actually emits:

- A1–A3: the OTLP spans (`status.code`, `name`, `duration`) exported by
  `packages/api/src/middleware/otel.ts`.
- A4 / A16: the `outbox.backlog` line the drain cron logs every minute
  (`ageMs` = age of the oldest pending event, `pending`). Both monitors
  also alert on **no data**: silence means the cron or the log pipeline
  stopped.
- A5: the `[dlq] drain cycle complete` line (`totalPending`) logged after
  every DLQ batch.

After the first apply, open each monitor in Axiom and run its query once to
confirm it returns rows on the dataset (see the field contract below), then
run the test fires below. The remaining entries of the table stay manual.

### Log field contract (#693)

The three log-based monitors (A4, A5, A16) read these paths on the
`AXIOM_LOGS_DATASET` events:

| Monitor              | Filter                                        | Field (top level)           | Emitter                                          |
| -------------------- | --------------------------------------------- | --------------------------- | ------------------------------------------------ |
| A4 `queue_lag`       | `['message'] == "outbox.backlog"`             | `['ageMs']` (number)        | `emitOutboxBacklogMetric` (`drain-scheduled.ts`) |
| A16 `outbox_backlog` | `['message'] == "outbox.backlog"`             | `['pending']` (number)      | `emitOutboxBacklogMetric` (`drain-scheduled.ts`) |
| A5 `dlq_depth`       | `['message'] == "[dlq] drain cycle complete"` | `['totalPending']` (number) | `handleDlqBatch` (`drain-dlq.ts`)                |

What the runtime guarantees:

- Each of these lines is **one** `console` call with **one** argument, a
  flat object `{ message: "<label>", ...fields }`, emitted through
  `logEvent()` (`packages/api/src/logging.ts`). The other `outbox.*`
  metric lines (`outbox.lane_backlog`, `outbox.drain_cycle`,
  `outbox.drain_overlap_risk`, `athlya.outbox.drain_errors`) use the same
  shape. Never log a monitored line as `console.log(label, meta)`: that
  reaches the pipeline as an argument array (`["label", { … }]`), with no
  `message` and no top-level field.
- `packages/api/src/__tests__/axiom-log-monitors.contract.test.ts` parses
  the queries in `axiom-monitors.tf`, runs the real emitters and fails if
  a referenced field is missing, nested or not numeric.

The log pipeline is declared in this repository (issue #697): the Tail
Worker `athlya-axiom-tail-<env>` (`packages/api/src/workers/axiom-tail.ts`,
`packages/api/wrangler.axiom-tail.toml`), named in `tail_consumers` by the
staging and production envs of the four API Worker configs.

- It turns each log entry whose console message is one plain object into
  one Axiom event: the object's keys at the top level, plus `_time` and
  `level` of the entry and `scriptName`, `outcome`, `eventTimestamp`,
  `eventType` (`scheduled` / `queue` / `fetch`) and `cron` or `queue` from
  the trace. A key the object sets itself (for example `outcome` on
  `device attestation verdict`) wins. Everything else is dropped: request
  URL and headers, exceptions, string lines and `console.log(label, meta)`
  argument lists.
- It posts batches of 500 events to
  `<AXIOM_URL>/v1/datasets/<AXIOM_LOGS_DATASET>/ingest` with the
  `AXIOM_INGEST_TOKEN` secret, 5 s per request. It never throws: a failed
  batch is logged on the tail Worker (`wrangler tail -c
wrangler.axiom-tail.toml --env <env>`) and lost, the producer is never
  affected.
- `packages/api/src/__tests__/axiom-tail.test.ts` runs the real emitters
  through the tail Worker and checks the shipped events against the same
  monitor contract as the runtime suite (`helpers/axiom-log-contract.ts`).

Sampling: `head_sampling_rate` (0.5 on staging, 0.1 in production) is the
Workers Logs setting of the `[observability]` block. Cloudflare documents
it for Workers Logs only; it does not document it as applying to
`tail_consumers`, so this pipeline is expected to receive every invocation,
the per-minute drain cron and the queue batches included. This is checked
on the environment, not assumed: the post-apply check below counts the
`outbox.backlog` events of the last 15 minutes. If production returns about
1 or 2 instead of about 15, sampling does apply to the tail: set
`head_sampling_rate = 1.0` in `[env.production.observability]` of
`wrangler.toml` (the Worker that runs the cron and the queue consumers) and
redeploy it.

### Setup and deploy order

1. Create an Axiom API token with **ingest** permission on the logs dataset
   only.
2. Make the `AXIOM_LOGS_DATASET` var of `[env.<env>.vars]` in
   `wrangler.axiom-tail.toml` equal to the `AXIOM_LOGS_DATASET` variable of
   the GitHub environment (the Terraform monitors read that one).
   `deploy-production.yml` (every deploy phase) and `canary.yml` refuse to
   deploy when they differ (`scripts/axiom-tail-dataset.mjs`), before any
   secret check, migration or deploy. `canary.yml` runs without a GitHub
   environment: set `AXIOM_LOGS_DATASET` as a repository variable too (the
   production dataset), or the canary stops as not provisioned.
3. Set the secret on each environment, before any deploy (verify-secrets
   checks it):
   `pnpm --filter @athlya/api exec wrangler secret put AXIOM_INGEST_TOKEN -c wrangler.axiom-tail.toml --env <staging|production>`.
4. Deploy the tail Worker **first**, then the API Workers. Cloudflare
   refuses to deploy a Worker whose `tail_consumers` names a Worker that
   does not exist. `deploy-production.yml` (staging and production) and
   `canary.yml` do it in that order; by hand:
   `pnpm --filter @athlya/api exec wrangler deploy -c wrangler.axiom-tail.toml --env <env>`.
5. Remove any log shipping set up by hand for these Workers (a Logpush job
   or another tail consumer to the same dataset), or every line arrives
   twice.

Post-apply check, on each environment, once the drain cron has run for a
few minutes (each query must return rows with a non-null value):

```apl
['<AXIOM_LOGS_DATASET>']
| where _time > now(-15m)
| where ['message'] == "outbox.backlog"
| project _time, ['pending'], ['ageMs'], ['scriptName'], ['eventType']
| take 5
```

Then check that no cron tick is sampled out (one `outbox.backlog` line per
minute, so about 15):

```apl
['<AXIOM_LOGS_DATASET>']
| where _time > now(-15m)
| where ['message'] == "outbox.backlog"
| summarize count()
```

A5 only gets data after a DLQ batch: run the T3 test fire below, then
query `['message'] == "[dlq] drain cycle complete"` and project
`['totalPending']`. If a query returns nothing, look at the raw events
(`| take 5` without the `where`): when `message` or the fields sit under
a wrapper, fix the pipeline mapping, not the monitor queries.

## Prérequis

- [ ] Dataset Axiom `athlya-spans` + `athlya-logs` reçoivent OTel depuis staging/prod (vérifier ingest dernière heure).
- [ ] Slack app → webhook → channel `#ops-athlya-alerts`.
- [ ] PagerDuty service `athlya-api` (Sev1/Sev2 page).
- [ ] Checkly CK2 couvre `/health/ready` 503 (hors Axiom — voir [`synthetic-monitoring.md`](../operations/synthetic-monitoring.md)).

---

## Inventaire des 14 monitors

| ID  | Nom                                | Sev | Route      | Query                  |
| --- | ---------------------------------- | --- | ---------- | ---------------------- |
| A1  | Error rate 5xx > 1% / 5m           | 2   | Slack      | `axiom-alerts.md` § A1 |
| A2  | auth.login p95 > 200ms             | 3   | Slack      | § A2                   |
| A3  | reservations.book p99 > 500ms      | 2   | Slack + PD | § A3                   |
| A4  | Queue lag p99 > 60s                | 2   | Slack      | § A4                   |
| A5  | DLQ pending > 100                  | 2   | Slack      | § A5                   |
| A6  | Suspicious login spike             | 3   | Slack      | § A6                   |
| A7  | Refresh token reuse                | 1   | Slack + PD | § A7                   |
| A8  | Concurrency 429 storm              | 3   | Slack      | § A8                   |
| A9  | Boot config error (CORS/Sentry EU) | 3   | Slack      | § A9                   |
| A10 | HIBP unavailable registrations     | 3   | Slack      | § A10                  |
| A11 | S1 booking burn rate > 2x          | 2   | Slack + PD | § A11                  |
| A12 | S3 error burn rate > 2x            | 2   | Slack + PD | § A12                  |
| A13 | S4 queue lag burn rate > 2x        | 3   | Slack      | § A13                  |
| A14 | QStash publish / quota stress      | 3   | Slack      | § A14                  |

**Mapping checklist launch (9 incident + 4 burn):**

| Item checklist                  | Monitor |
| ------------------------------- | ------- |
| DLQ non-vide                    | A5      |
| Login anomaly spike             | A6      |
| HIBP service down               | A10     |
| Error rate / 5xx                | A1      |
| Booking p99 SLO                 | A3, A11 |
| Queue / notification lag        | A4, A13 |
| Refresh reuse (security)        | A7      |
| Config boot errors              | A9      |
| Concurrency storm               | A8      |
| Burn availability (proxy error) | A12     |
| Burn latency login              | A2      |
| QStash quota / publish failures | A14     |

Items checklist **non-Axiom** (autre outil) : JWKS rotation expirée → runbook [`rotate-jwt.md`](./rotate-jwt.md) + alerte calendrier ; Stripe webhook → Sentry + audit `billing.stripe.signature_failed` ; RLS violation → audit `rls.violation` + future log alert ; RGPD cron skip → log `rgpd_maintenance_cycle_skipped` (alerte logs Phase B).

---

## Manual monitor procedure (Axiom UI)

For each **manual** monitor only (A6–A15, A17, A18). A1–A5 and A16 are
Terraform-managed (see above): never create or edit them in the UI.

1. **Monitors → New monitor → Custom query**
2. Paste the APL query from `axiom-alerts.md`
3. **Trigger:** `Number of results` > 0 (or equivalent)
4. **Evaluation window:** see the cooldown in the alert entry
5. **Notification:** Slack `#ops-athlya-alerts`; add PagerDuty for Sev1/Sev2 when paging is listed
6. **Snooze / cooldown:** value documented in `axiom-alerts.md`
7. Record the Axiom **Monitor ID** in the table below (ops commit or ticket)

### Provisioning tracking table

| ID  | Axiom monitor ID                                       | Provisioned | Test fire |
| --- | ------------------------------------------------------ | ----------- | --------- |
| A1  | Terraform `axiom_monitor.slo["api_5xx_rate"]`          | [ ] applied | [ ]       |
| A2  | Terraform `axiom_monitor.slo["auth_login_p95"]`        | [ ] applied | [ ]       |
| A3  | Terraform `axiom_monitor.slo["reservations_book_p99"]` | [ ] applied | [ ]       |
| A4  | Terraform `axiom_monitor.slo["queue_lag"]`             | [ ] applied | [ ]       |
| A5  | Terraform `axiom_monitor.slo["dlq_depth"]`             | [ ] applied | [ ]       |
| A6  |                                                        | [ ]         | [ ]       |
| A7  |                                                        | [ ]         | [ ]       |
| A8  |                                                        | [ ]         | [ ]       |
| A9  |                                                        | [ ]         | [ ]       |
| A10 |                                                        | [ ]         | [ ]       |
| A11 |                                                        | [ ]         | [ ]       |
| A12 |                                                        | [ ]         | [ ]       |
| A13 |                                                        | [ ]         | [ ]       |
| A14 |                                                        | [ ]         | [ ]       |
| A16 | Terraform `axiom_monitor.slo["outbox_backlog"]`        | [ ] applied | [ ]       |

---

## Tests obligatoires (min. 3 avant go-live)

### T1 — Readiness / infra (Checkly, pas Axiom)

Sur staging, provoquer 2× `/health/ready` 503 (secret DB_URL invalide temporaire) → alerte CK2.

### T2 — Error rate (A1)

Staging : générer >1% 5xx sur 5 min (endpoint test ou binding cassé volontairement) → Slack A1.

### T3 — DLQ / outbox (A5 ou snapshot)

Staging : publier message invalide sur queue → DLQ > 0 → A5 ou inspection [`event-bus.md`](./event-bus.md).

Documenter captures Slack + Monitor ID dans le ticket #120 ou wiki ops.

---

## Validation finale

```powershell
node scripts/verify-axiom-alerts-checklist.mjs
```

Tous les `[ ]` cochés en prod + staging ; aucun monitor en état `Firing` non expliqué pendant **7 jours** (Phase A checklist).

---

## Escalade

| Sev | Action                                                    |
| --- | --------------------------------------------------------- |
| 1   | Page on-call immédiat (A7)                                |
| 2   | Slack + page si pas ACK 30 min (A1, A3, A4, A5, A11, A12) |
| 3   | Slack only — investigation jour ouvré                     |

Runbooks liés : [`outbox-ops.md`](./outbox-ops.md), [`event-bus.md`](./event-bus.md), [`cost-monitoring.md`](./cost-monitoring.md), [`canary-deploy.md`](./canary-deploy.md).

---

## Références

- Issue #120, audit O3
- [`docs/operations/v1.0.0-launch-checklist.md`](../operations/v1.0.0-launch-checklist.md) Day 2
- [`docs/operations/axiom-queries.md`](../operations/axiom-queries.md)
