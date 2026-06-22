# Runbook — Neon compute min_cu configuration

**Issue:** #316 — Neon cold starts structurally break p99 < 500ms SLO on irregular traffic.

## Problem

Neon serverless suspends compute after ~5 minutes of inactivity. A suspended
compute takes 500ms–2s to resume on the next query. The Athlya cron (every
minute) touches `CRON_DB_URL` and keeps that compute warm, but the main
`DB_URL` endpoint can still cold-start between the cron's `countPendingOutbox`
call and the next user request if Neon uses different compute endpoints for
HTTP vs interactive sessions.

The permanent fix is `min_cu = 0.25` on the Neon project compute, which
prevents full suspension by keeping a quarter of a compute unit always active.

## Monitoring

The `db_keepalive` cron probe (added in this issue) emits a structured log
line every minute:

```json
{
  "event": "db_keepalive",
  "label": "cron_db",
  "latencyMs": 12,
  "coldStartSuspected": false,
  "threshold_ms": 400
}
```

When `coldStartSuspected: true` (latency > 400ms), an additional
`db_cold_start_suspected` warning is emitted. Configure an Axiom alert on
this field:

```
event = "db_cold_start_suspected"
```

Alert channel: same as capacity drift alert (A17) — Slack `#athlya-ops`.

## Setting min_cu on Neon (staging and production)

Neon does not expose `min_cu` via its REST API at this time — it must be set
from the Neon Console or via the project config API.

### Via Neon Console

1. Go to **Neon Console → [project] → Compute**.
2. For each branch (staging, production): click **Edit** on the primary compute.
3. Set **Min compute size** to `0.25 CU`.
4. Save. The change takes effect immediately — no restart required.

### Via Neon API (once available)

```bash
curl -X PATCH "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/endpoints/${ENDPOINT_ID}" \
  -H "Authorization: Bearer ${NEON_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"endpoint": {"min_cu": 0.25}}'
```

Replace `ENDPOINT_ID` with the primary read-write endpoint ID visible in the
Neon Console under **Compute → Endpoint ID**.

## Verification

After setting `min_cu = 0.25`:

1. Wait 10 minutes (let any active compute settle).
2. Trigger a manual cron tick via `wrangler dev --test-scheduled` or wait for
   the next minute.
3. In Cloudflare Logpush / Axiom, verify `latencyMs < 100` on the next
   `db_keepalive` event.
4. Confirm `coldStartSuspected: false` on the following tick.

## Cost impact

`min_cu = 0.25` keeps a quarter compute unit active at all times.
Neon bills idle compute at the CU-hour rate for your plan. At the Free tier
this is included in the always-on compute; on paid plans, estimate:

```
0.25 CU × 730 h/month × $0.16/CU-h ≈ $2.92/month per branch
```

This is negligible relative to the SLO impact of cold starts.

## Acceptance criteria (issue #316)

- [ ] `min_cu = 0.25` set on staging and production primary compute
- [ ] `db_keepalive` logs show `latencyMs < 100` after idle period
- [ ] Axiom alert configured on `db_cold_start_suspected`
- [ ] p99 for `GET /v1/classes` < 300ms measured after 10-min idle (load test)
