# Automatic Rollback Runbook

CN.7.3 (issue #632) — automatic rollback of every production Worker on a
sustained SLO breach.

The canary (`canary.yml`, CN.7.1) rolls a release back while it is shifting
traffic. Once it reports success, `slo-rollback.yml` takes over: when the API
breaches an SLO for ten consecutive minutes, it rolls the **whole bulkhead
set** (gateway, auth, reservations, billing) back to the version each Worker
served at 100 % before the release, or touches nothing.

## Trigger conditions

Evaluated over one-minute bins of the production spans dataset, with the same
span filter and sampling correction as the A1 `api_5xx_rate` monitor:

| Signal         | Breach when, in **each** of the last 10 whole minutes   |
| -------------- | ------------------------------------------------------- |
| 5xx share      | > 2 %                                                   |
| p99 latency    | > 2 000 ms over non-5xx spans, ≥ 20 sampled per minute  |
| Request volume | ≥ 20 estimated requests in that minute (else no breach) |

A missing or quiet minute is not a breach. The values live in `SLO_ROLLBACK`
(`scripts/slo-rollback.mjs`); the Axiom monitors in
`infra/terraform/slo-auto-rollback.tf` use the same ones (asserted by
`scripts/__tests__/slo-rollback.test.mjs`). Change both together.

## How it works

1. Axiom monitor `SLO auto-rollback: …` fires after 10 consecutive breaching
   one-minute runs. Its custom-webhook notifier calls the GitHub
   `workflow_dispatch` API for `slo-rollback.yml` on `master`. The monitors
   also notify the usual Slack notifiers.
2. `slo-rollback.yml` (environment `production-rollback`, concurrency group
   shared with `canary.yml`, `rollback.yml` and the production phases of
   `deploy-production.yml`) does nothing unless
   `vars.AUTO_ROLLBACK_ENABLED == 'true'`, and fails when a prerequisite is
   missing.
3. **Re-check** — `slo-rollback.mjs check` queries Axiom itself with a
   read-only token. The webhook payload is never trusted: no sustained breach
   → the run ends green, nothing touched (stale, flapping or spoofed alert).
4. **Plan** — `slo-rollback.mjs plan` reads `wrangler deployments list --json`
   and `wrangler versions view --json` for each Worker. The target is the
   latest earlier deployment that served a **different** version at 100 %.
   It refuses (no Worker touched, run red, on-call paged) when:
   - a deployment splits traffic (a canary is in progress);
   - the live deployment is younger than the 10 min window (the breach may
     predate it) or older than 24 h;
   - the live deployment is already a rollback (rolling back again would
     redeploy the bad version), or any rollback happened in the last 60 min
     (cool-down);
   - a secret change, a hotfix or any third version was deployed between the
     target and the live version;
   - a Worker has no previous version;
   - the release SHAs (the `VERSION` var) cannot be read, differ between
     Workers, or are identical on both sides;
   - the target release is not an ancestor of the live one, or a forward
     migration marked `-- athlya:contract` landed between them (see
     [expand-contract-migrations.md](./expand-contract-migrations.md)).

   When every Worker already serves a rollback made within the cool-down, the
   plan is `noop`: a duplicate webhook is harmless.

5. **Rollback** — `slo-rollback.mjs rollback` re-reads the live deployments
   (abort if anything moved since the plan), then runs
   `wrangler versions deploy --version-id <target> --percentage 100` for the
   gateway, billing, reservations and auth, in that order, with the message
   `slo-rollback <live> -> <target>: run <id>`. It then checks every Worker
   serves its target at 100 %. A Worker already on its target is skipped, so
   a re-run finishes an interrupted rollback. If the gateway fails, the
   sub-workers are not touched (a new gateway in front of older sub-workers
   is the skew the order avoids).
   `wrangler rollback` is not used: in CI it auto-confirms Cloudflare's
   "secrets have changed" refusal, `versions deploy` never does.
6. `/health/ready` gate, a GitHub issue with the evidence (Axiom bins, plan,
   rollback log), Slack (`SLACK_WEBHOOK_URL`) and PagerDuty
   (`PAGERDUTY_ROUTING_KEY`, `critical` on failure, `warning` on success).
   A dry run records a `DRY RUN` issue and pages nobody.

Bound resources (D1, KV, R2, queues, Durable Object storage) and the database
schema are **not** rolled back. That is why contract migrations block it.

## Operator setup

1. **Axiom query token** — Settings → API tokens → new token with **query**
   access to the production spans dataset only (no ingest, no monitors).
2. **GitHub environment `production-rollback`** — Settings → Environments →
   New environment. No required reviewers (they would stall the rollback);
   deployment branches: **selected branches → `master`**. Add:
   - secret `AXIOM_QUERY_TOKEN` (step 1);
   - variable `AXIOM_SPANS_DATASET` — the production spans dataset;
   - variable `AXIOM_URL` — optional, only for a non-default Axiom edge;
   - variable `AUTO_ROLLBACK_ENABLED` = `true` (last, once everything else is
     in place).

   Repository-level `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
   `PRODUCTION_API_URL` are reused. Optional: `SLACK_WEBHOOK_URL`,
   `PAGERDUTY_ROUTING_KEY` (PagerDuty Events API v2 integration key).

3. **Dry run** — `gh workflow run slo-rollback.yml -f reason="dry run" -f dry_run=true`.
   Without a breach the run stops after the re-check. To exercise the planner,
   read the summary of a run during a real incident, or run
   `node scripts/slo-rollback.mjs plan --out /tmp/plan.json` locally with
   production Cloudflare credentials (read-only commands).
4. **Fine-grained PAT** for the Axiom notifier — GitHub → Settings →
   Developer settings → Fine-grained tokens: resource owner
   `GlamgarOnDiscord`, repository access **only** `athlya`, permission
   **Actions: Read and write**, nothing else; 90-day expiry, calendar the
   rotation.
5. **Terraform** (production environment of `terraform.yml`):
   - secret `TF_VAR_slo_auto_rollback_github_token` = the PAT (step 4);
   - variable `SLO_AUTO_ROLLBACK_MONITOR_ENABLED` = `true`.

   Run `terraform.yml` with `environment=production`, `action=plan`, check
   that only `axiom_notifier.slo_auto_rollback` and the two
   `axiom_monitor.slo_auto_rollback` monitors are added, then `apply`.

The PAT lives only in the Axiom notifier (sensitive header) and Terraform
state; it never reaches the repository or a workflow log.

## Disable auto-rollback

- Instant: set `AUTO_ROLLBACK_ENABLED` to `false` (or delete it) in the
  `production-rollback` environment. Dispatches still run but do nothing.
- Permanent: set `SLO_AUTO_ROLLBACK_MONITOR_ENABLED` to `false` and apply
  Terraform (removes the monitors and the notifier), then revoke the PAT.

## When the run is red

- **Refused** — read the reasons in the run summary or the issue. Nothing was
  touched; decide by hand. Manual rollback of the whole fleet:

  ```bash
  cd packages/api
  for c in wrangler.toml wrangler.billing.toml wrangler.reservations.toml wrangler.auth.toml; do
    pnpm exec wrangler deployments list -c "$c" --env production
  done
  # then, per Worker, gateway first:
  pnpm exec wrangler versions deploy -c <config> --env production \
    --version-id <previous-version-id> --percentage 100 -m "manual rollback" -y
  ```

- **Rollback incomplete** — some Workers may run the previous release and
  others the new one. Re-run the workflow (Re-run all jobs): Workers already on
  their target are skipped. If it fails again, finish by hand as above.
- **Cancelled** — the production lock keeps only one pending run: a canary
  push or another dispatch that queues behind a running deploy cancels a
  rollback still waiting for the lock, before any step runs. The
  `cancelled-alert` job then fails the run, opens a `SLO auto-rollback
cancelled` issue and posts to Slack. If the SLO is still breached,
  re-dispatch: `gh workflow run slo-rollback.yml -f reason="re-dispatch"`.
  A cancelled `rollback` phase of `deploy-production.yml` or `rollback.yml`
  run must likewise be re-dispatched by hand.
- **Not provisioned** — a secret or variable listed above is missing.
- **Axiom query failed** — no decision possible; check the token and the
  Axiom status, then roll back by hand if the incident is real.

## Manual rollback workflow

`rollback.yml` stays available for a manual rollback of the **gateway only**
(optionally to an explicit version). For a fleet-wide manual rollback, use the
commands above. A manual dispatch of `slo-rollback.yml` is **not** an
unconditional rollback: it still requires Axiom to confirm a sustained breach
and every guard to pass, otherwise it does nothing (or refuses).

## Re-promote after investigation

Once the root cause is fixed on `master`, `canary.yml` promotes the new
release (1 % → 10 % → 100 %). The 60 min cool-down blocks a second automatic
rollback within an hour of the first one; the fix must be watched by a human
during that hour.
