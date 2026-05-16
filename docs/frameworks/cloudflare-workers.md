# Cloudflare Workers — Framework Audit

*Last updated: 2026-05-14*

## Version Status

| | Value |
|---|---|
| **Wrangler** | ^4.0.0 (resolved ~4.91.0) |
| **@cloudflare/workers-types** | ^4.20241218.0 (resolves to 4.20260509.1) |
| **Compatibility date** | 2025-10-30 |
| **Compat flags** | `nodejs_compat` |

---

## Compatibility Date — Bump Recommended

The project uses `compatibility_date = "2025-10-30"`. Cloudflare releases new runtime features behind compatibility flags. Recent additions behind newer dates:

| Date | Feature |
|---|---|
| 2025-11-15 | Improved `nodejs_compat` — better `net`, `tls`, `dns` APIs |
| 2026-01-01 | WebSocket Hibernation API improvements |
| 2026-03-01 | `console.log` structured output (JSON-friendly) |

**Recommendation**: Bump to `2026-03-01`. Run `wrangler dev` locally and `wrangler deploy --env staging` to verify no regressions before deploying to production.

---

## Configuration Assessment

### Strengths

1. **Environment matrix**: dev / staging / production properly separated
2. **Secrets policy**: All credentials via `wrangler secret put`, never in file
3. **Queue architecture**: Events queue + DLQ with proper retry/batch config
4. **Smart Placement**: Enabled for staging/production (EU co-location)
5. **Observability**: 100% head sampling (adjust at scale)
6. **Cron trigger**: 1-minute outbox drain
7. **`@cloudflare/workers-types`** resolves to 4.20260509.1 (May 2026) — current

### `nodejs_compat` Flag

Enables Node.js APIs in Workers (required for `postgres` driver, `node:crypto`, `node:stream`, etc.). This is the modern flag — replaces the older `node_compat`. Correct.

---

## Missing: Hyperdrive

`project.md` mentions Cloudflare Hyperdrive for connection pooling, but no `[[hyperdrive]]` binding in `wrangler.toml`. Current `postgres.js` with `max: 10` works per-isolate.

**Why Hyperdrive matters**: Cold-start latency on Neon is 300-500ms after scale-to-zero. Hyperdrive keeps warm connections at Cloudflare PoPs, reducing first-query latency to ~5ms.

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<hyperdrive-config-id>"
caching.disabled = false
```

```ts
// packages/db/src/client.ts
const client = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,      // smaller pool — Hyperdrive handles pooling
    prepare: false,
});
```

Add when Neon cold starts are observed in production metrics.

---

## Missing: Durable Objects

No Durable Objects configured. For current architecture (stateless Workers + Redis + Postgres), this is correct. Consider for future real-time features:
- Live class capacity updates (WebSocket rooms)
- Collaborative schedule editing

---

## Worker Size Limits

Workers compressed limit: **10MB** (paid plan), **1MB** (free plan).

With Drizzle + Zod + Hono, estimated bundle size is ~300-400KB compressed — well within limits. No action needed, but monitor as codebase grows:

```bash
wrangler deploy --dry-run --env staging 2>&1 | grep "Bundle size"
```

---

## Security

- TLS 1.3 enforced at Cloudflare edge (not Worker-level — transparent)
- Secrets separated from vars in `wrangler.toml`
- No environment-specific secrets in config file
- `VERSION` var for deployment tracking

---

## Performance

| Factor | Value |
|---|---|
| Cold start | ~5ms (V8 isolates) |
| Smart Placement | Reduces latency to EU data stores |
| Module-scope caching | Redis, Postgres clients per-isolate |
| `ctx.waitUntil()` | Used for fire-and-forget (Sentry, outbox drain) |

---

## Checklist

- [x] Proper environment separation (dev/staging/production)
- [x] Secrets policy (never in wrangler.toml)
- [x] Queue + DLQ architecture
- [x] Smart Placement for EU
- [x] `nodejs_compat` flag
- [x] Cron trigger for outbox drain
- [x] Observability enabled
- [x] `@cloudflare/workers-types` resolves to current (4.20260509.1)
- [ ] Bump `compatibility_date` to 2026-03-01
- [ ] Add Hyperdrive binding when cold start latency is observed
- [ ] Monitor bundle size with `wrangler deploy --dry-run`

## Sources

- https://developers.cloudflare.com/workers/
- https://developers.cloudflare.com/workers/configuration/compatibility-dates/
- https://developers.cloudflare.com/hyperdrive/
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/
