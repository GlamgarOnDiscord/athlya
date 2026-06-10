# Automatic Rollback Runbook

CN.7.3 — automatic production rollback on SLO breach.

## Trigger conditions

The rollback workflow fires when **either** of these conditions holds for **5 consecutive minutes**:

| Metric              | Threshold    |
| ------------------- | ------------ |
| p99 latency         | > 2 000 ms   |
| 5-minute error rate | > 2 % (0.02) |

Configure the Axiom monitor to POST to the GitHub Actions workflow dispatch endpoint (see below).

## How it works

1. Axiom alert fires → webhook to GitHub Actions `rollback.yml`.
2. `rollback.yml` calls `scripts/canary-deploy.mjs rollback --env production` → `wrangler rollback`.
3. Post-rollback `/health/ready` gate confirms the previous version is serving.
4. Slack notification (if `SLACK_WEBHOOK_URL` is set) reports the outcome.

## Manual trigger

```bash
gh workflow run rollback.yml \
  --field reason="manual: p99 spike after deploy abc1234"
```

Target a specific version:

```bash
gh workflow run rollback.yml \
  --field reason="manual rollback" \
  --field version_id="<VERSION_ID>"
```

List available versions:

```bash
pnpm --filter @athlya/api exec wrangler versions list --env production --json \
  | jq '(if type == "array" then . else .versions end) | .[] | {id, created_on}'
```

## Axiom alert configuration

Create an alert in Axiom on the `athlya-production` dataset:

```
| summarize
    p99_ms = percentile(duration_ms, 99),
    errors = countif(status >= 500),
    total  = count()
  by bin(_time, 1m)
| extend error_rate = todouble(errors) / todouble(total)
| where p99_ms > 2000 or error_rate > 0.02
```

Alert type: **consecutive** — fire after **5** consecutive matching windows.

Webhook URL:

```
https://api.github.com/repos/GlamgarOnDiscord/athlya/actions/workflows/rollback.yml/dispatches
```

Headers:

```
Authorization: Bearer <GITHUB_PAT with workflow scope>
Content-Type: application/json
```

Body:

```json
{
  "ref": "master",
  "inputs": {
    "reason": "axiom-alert: p99 or error_rate threshold exceeded"
  }
}
```

## Disable auto-rollback

Delete the Axiom alert to stop the webhook trigger. The `rollback.yml` workflow remains available for manual use.

## Re-promote after investigation

Once the root cause is fixed and a new commit is on master, the `canary.yml` workflow auto-triggers on push and re-promotes to 100 %.

To force a re-promote without a new commit:

```bash
gh workflow run deploy-production.yml \
  --field phase="production-canary" \
  --field wait_minutes="5"
```
