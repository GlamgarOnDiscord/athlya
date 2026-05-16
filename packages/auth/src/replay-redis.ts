/**
 * Upstash Redis adapter for the QR-check-in {@link ReplayStore}.
 *
 * Requirement 11.4 mandates that every consumed QR token's `jti` be
 * stored in a Redis set with TTL 120 s so a replay of the same token
 * within its validity window can be detected (Requirement 11.5). This
 * adapter provides that storage.
 *
 * ### Storage layout
 *
 * Each consumed `jti` is a single Redis key of the form
 * `<prefix>:<jti>` (default prefix `qr:replay`). The value is the
 * literal string `"1"` — only the key's existence and TTL matter.
 *
 * We deliberately use individual keys rather than a Redis `SET` with
 * `EXPIREAT` members for two reasons:
 *
 *   1. Redis does not natively expire individual set members; to get
 *      per-jti TTL we would need a sorted set with timestamp scores
 *      and periodic trimming, which is more moving parts than a flat
 *      key-per-jti with Redis's built-in TTL.
 *   2. Upstash charges per operation; `GET` + `SET NX EX` is two ops,
 *      same as a sorted-set solution, without the trim overhead.
 *
 * ### Semantics
 *
 *   - `has(jti)` → `GET <prefix>:<jti>` → truthy iff the token has
 *     been consumed within its validity window.
 *   - `add(jti, ttlSec)` → `SET <prefix>:<jti> 1 NX EX <ttlSec>`.
 *     `NX` is defensive: two concurrent verifications of the same
 *     token would race between `has` and `add`, and the second `add`
 *     would (without NX) refresh the TTL of an existing entry. `NX`
 *     makes the write a no-op in that case, preserving the original
 *     expiry.
 *
 * Related requirements: 11.4, 11.5.
 */

import type { ReplayStore } from './qr.js';
import type { Redis } from '@upstash/redis';

/**
 * Default Redis key prefix under which QR `jti`s are stored.
 * Overridable via the second argument of
 * {@link createRedisReplayStore} so multiple apps can share a Redis
 * database without colliding.
 */
export const DEFAULT_QR_REPLAY_PREFIX = 'qr:replay';

/**
 * Creates a {@link ReplayStore} backed by an Upstash Redis client.
 *
 * ### Preconditions
 *
 * - `redis` is an authenticated Upstash Redis client (typically
 *   `Redis.fromEnv()` on Cloudflare Workers).
 * - `prefix` is a non-empty string containing only characters safe in
 *   a Redis key; the default is safe.
 *
 * ### Postconditions
 *
 * - `has(jti)` returns a boolean: `true` iff the key exists.
 * - `add(jti, ttlSec)` is a no-op when the key already exists
 *   (because of `NX`) and otherwise sets the key with the supplied
 *   TTL. `ttlSec` is clamped to at least 1 second — Upstash rejects
 *   `EX 0`.
 *
 * The returned store is stateless beyond its closed-over `redis` and
 * `prefix`, so callers can create it once per Worker and reuse it
 * across requests.
 */
export function createRedisReplayStore(
    redis: Redis,
    prefix: string = DEFAULT_QR_REPLAY_PREFIX,
): ReplayStore {
    if (typeof prefix !== 'string' || prefix.length === 0) {
        throw new TypeError('createRedisReplayStore: prefix must be a non-empty string');
    }

    return {
        async has(jti: string): Promise<boolean> {
            assertJti(jti);
            const existing = await redis.get<string | null>(`${prefix}:${jti}`);
            return existing !== null && existing !== undefined;
        },
        async add(jti: string, ttlSec: number): Promise<void> {
            assertJti(jti);
            if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
                throw new RangeError(
                    `createRedisReplayStore.add: ttlSec must be > 0, got ${String(ttlSec)}`,
                );
            }
            const ex = Math.max(1, Math.floor(ttlSec));
            await redis.set(`${prefix}:${jti}`, '1', { ex, nx: true });
        },
    };
}

function assertJti(jti: string): void {
    if (typeof jti !== 'string' || jti.length === 0) {
        throw new TypeError('jti must be a non-empty string');
    }
}
