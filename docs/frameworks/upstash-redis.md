# @upstash/redis — Framework Audit

*Last updated: 2026-05-14*

## Version Status

| | Value |
|---|---|
| **Used** | ^1.35.6 |
| **Latest** | **1.38.0** |
| **Purpose** | Rate limiting, QR replay store, login throttle, DLQ tracking |
| **Runtime** | HTTP-based (no TCP, Workers-compatible) |

---

## BREAKING — 1.38.0: Auto Pipeline Read/Write Separation

Upstash Redis 1.38.0 introduced automatic pipeline read/write routing for accounts with read replicas. If `REDIS_URL` points to a primary that has read replicas configured:

- **Writes** (SET, ZADD, EXPIRE, DEL) → primary
- **Reads** (GET, ZCARD, ZRANGE) → nearest replica

**Impact on this project**: The pipelining pattern in `packages/ratelimit/src/sliding-window.ts` mixes reads and writes in a single pipeline (ZREMRANGEBYSCORE + ZADD + ZCARD + EXPIRE). With read/write separation, a pipeline containing both is still routed correctly — Upstash separates internally by operation type within the pipeline.

**Action**: Verify the pipeline still completes atomically after upgrading to 1.38.0. The sorted-set sliding window depends on atomicity: the ZADD + ZCARD within the same pipeline must reflect consistent state.

```bash
# Check current resolved version
pnpm why @upstash/redis
```

If using Upstash with read replicas, test the rate limiter under load after upgrade.

---

## Why Upstash Redis

- HTTP-based protocol (not TCP) — compatible with Cloudflare Workers (no socket API needed)
- Serverless pricing (pay per operation)
- Global replication available (EU region for RGPD compliance)
- Built-in TLS, no connection management

---

## Usage in Project

| Module | Redis Usage |
|---|---|
| `packages/ratelimit/src/sliding-window.ts` | Sorted set for sliding window rate limiting |
| `packages/api/src/middleware/rate-limit.ts` | Global rate limit (100/s IP, 500/s user) |
| `packages/auth/src/throttle.ts` | Login throttle (5/15min per IP+email) |
| `packages/auth/src/replay-redis.ts` | QR check-in replay prevention (SET NX EX) |
| `packages/api/src/events/drain-dlq.ts` | DLQ entry tracking |

---

## Patterns

### Client Caching (rate-limit.ts)

Module-scope `Map` caches Redis clients keyed by URL. Per-isolate lifetime on Workers (cleared on eviction). Multi-env safe (different URLs → different clients).

### Pipelining (sliding-window.ts)

Single HTTP request for 4 operations: ZREMRANGEBYSCORE + ZADD + ZCARD + EXPIRE. Minimizes latency (1 RTT instead of 4).

**With 1.38.0 read/write routing**: Upstash handles the routing internally per operation in the pipeline. The atomicity guarantee is maintained within a single pipeline request.

### SET NX EX (replay-redis.ts)

Atomic "set if not exists with TTL" — race-safe replay prevention for QR check-in tokens.

---

## Security

- `REDIS_URL` and `REDIS_TOKEN` stored as Cloudflare Secrets (never in `wrangler.toml`)
- Client created lazily from env bindings, not at module scope with hardcoded credentials
- Key prefixes prevent namespace collisions (`rl:ip:`, `rl:user:`, `auth:login:`, `qr:replay:`, `dlq:`)

---

## Performance

- HTTP-based: each pipeline = one HTTP request (~5-10ms to Upstash EU)
- Pipeline pattern is critical — avoid individual calls in hot paths
- Sorted sets for sliding windows: O(log N) per operation, auto-expire via key TTL
- QR replay: GET + conditional SET NX — 2 operations per check-in

---

## Checklist

- [x] HTTP-based client (Workers compatible)
- [x] Client caching per isolate
- [x] Pipeline for hot-path operations
- [x] SET NX EX for atomic race-safe operations
- [x] Key prefixes to prevent collisions
- [x] Credentials in secrets, not config
- [ ] **Upgrade to 1.38.0 and verify pipeline atomicity with read/write routing**
- [ ] Add Upstash observability (request latency metrics) via Cloudflare Worker analytics

## Sources

- https://upstash.com/docs/redis/overall/getstarted
- https://github.com/upstash/redis-js/releases/tag/v1.38.0
- https://upstash.com/docs/redis/features/pipelining
