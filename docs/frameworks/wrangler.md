# Wrangler — Framework Audit

_Last updated: 2026-05-14_

## Version Status

|              | Value                                         |
| ------------ | --------------------------------------------- |
| **Used**     | ^4.0.0                                        |
| **Resolved** | ~4.90.0                                       |
| **Latest**   | **4.91.0**                                    |
| **Purpose**  | Cloudflare Workers CLI (dev, deploy, secrets) |

---

## What's New in Wrangler 4.91.0

### Named Dev Tunnels (4.88+)

Persistent named tunnel URLs instead of random URLs per `wrangler dev` session:

```bash
# Generates a stable URL: https://athlya-dev.trycloudflare.com
wrangler dev --remote --tunnel-name athlya-dev
```

Useful for:

- Webhook development (Stripe, Turnstile callbacks)
- OAuth redirect URIs that need to stay consistent between sessions
- Sharing dev environment with external parties

### Auto Log Cleanup (4.90+)

`wrangler tail` now auto-clears stale log sessions after worker redeployment. Previously, stale sessions accumulated and caused noise.

### Durable Objects `--experimental-local-sqlite` (4.89+)

For projects adding Durable Objects in future: local SQLite backend for DO storage in `wrangler dev`. Not applicable yet but relevant if WebSocket rooms are added.

### `wrangler dev --mcp` (Workers AI)

Exposes the Worker as an MCP server for AI tooling (Claude Code, Cursor). Not applicable to the API worker directly, but noted.

---

## Configuration (wrangler.toml)

Well-structured three-environment setup:

- `[env.dev]` — local development (no route, localhost)
- `[env.staging]` — `staging.api.athlya.app/*`
- `[env.production]` — `api.athlya.app/*`

### Key Settings

| Setting                 | Value                  | Assessment                |
| ----------------------- | ---------------------- | ------------------------- |
| `compatibility_date`    | 2025-10-30             | Adequate — see note below |
| `compatibility_flags`   | `["nodejs_compat"]`    | Required for postgres.js  |
| `main`                  | `src/worker.ts`        | Direct TS entry           |
| `observability.enabled` | true                   | 100% head sampling        |
| `placement.mode`        | "smart" (staging/prod) | EU co-location            |

**Note on `compatibility_date`**: Wrangler 4.91 defaults to the current date for new projects. The project is on 2025-10-30. Consider bumping to 2026-03-01 or later to access newer Workers runtime features (updated V8 APIs, improved `nodejs_compat`). Test before bumping.

### Queue Configuration

Two queues: `athlya-events` (main) + `athlya-events-dlq` (dead letter).

| Config            | Events Queue      | DLQ    |
| ----------------- | ----------------- | ------ |
| max_batch_size    | 10                | 10     |
| max_batch_timeout | 5s                | 30s    |
| max_retries       | 5                 | 3      |
| dead_letter_queue | athlya-events-dlq | (none) |

Queue bindings duplicated into each named env (defensive against Wrangler 3.x inheritance bugs — still valid practice).

### Cron Trigger

```toml
[triggers]
crons = ["* * * * *"]  # Every minute — outbox drain
```

---

## Secrets Policy

All credentials via `wrangler secret put`:

- `REDIS_TOKEN` / `REDIS_URL`
- `DB_URL`
- `JWT_JWKS_URL`
- `SENTRY_DSN`
- `TURNSTILE_SECRET`
- `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS`

None in `wrangler.toml` (verified).

---

## Scripts

```json
"dev": "wrangler dev",
"deploy:staging": "wrangler deploy --env staging",
"deploy:production": "wrangler deploy --env production"
```

---

## Checklist

- [x] Three-environment separation
- [x] Secrets never in config file
- [x] `nodejs_compat` for postgres.js
- [x] Smart Placement for EU
- [x] Queue + DLQ architecture
- [x] Cron trigger for outbox drain
- [x] Observability enabled
- [ ] Bump `compatibility_date` to 2026-03-01 (or later) for newer Workers APIs
- [ ] Consider named dev tunnels for webhook/OAuth dev workflows

## Sources

- https://developers.cloudflare.com/workers/wrangler/
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://github.com/cloudflare/workers-sdk/releases/tag/wrangler@4.91.0
