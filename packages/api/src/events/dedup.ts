/**
 * Consumer-side event dedup — slice B6.3.
 *
 * Cloudflare Queues delivers messages **at-least-once**. Combined with
 * the outbox drain (`./drain-worker.ts`), a single domain `event.id`
 * may legitimately reach the consumer pipeline more than once:
 *
 *   - Drain claimed a row, queue.send succeeded, `markPublished`
 *     failed → next drain re-publishes the same envelope.
 *   - Cloudflare retries a consumer batch after a transient
 *     downstream failure → every message in that batch is redelivered
 *     even if some sibling messages already succeeded.
 *   - DLQ replay (`./drain-dlq.ts → dlqReplay`) puts a previously
 *     processed envelope back on the main queue.
 *
 * Requirement 17.4 mandates that consumers absorb these duplicates by
 * deduping on `event.id` for at least 24 hours. This module is the
 * primitive every consumer wraps around its handler:
 *
 *   ```ts
 *   const fresh = await assertNotSeen(redis, event.id);
 *   if (!fresh) return;        // already processed, skip silently
 *   await applySideEffect(event);
 *   ```
 *
 * Design notes
 * ------------
 * 1. **`SET … NX EX` is the entire algorithm.** Upstash's REST API
 *    accepts the same flags as the Redis text protocol, so a single
 *    round-trip both checks for prior occurrence AND records the
 *    sighting atomically. A naive `GET` + `SET` would race between
 *    two consumer replicas processing the same redelivery.
 *
 * 2. **TTL is 24 h by default.** Req 17.4 spells out the window. The
 *    function clamps the configured TTL to ≥ 1 second because Upstash
 *    rejects `EX 0`.
 *
 * 3. **Mirror of `replay-redis.ts`.** The QR check-in module
 *    (`packages/auth/src/replay-redis.ts`) implements the exact same
 *    pattern for `jti` replay protection. Both modules stay
 *    independent so a future change to either window does not bleed
 *    into the other.
 *
 * 4. **Key prefix `events:seen:`.** Distinct from `qr:replay:` and
 *    `dlq:entry:` so a future Redis key-scan never confuses
 *    consumer-dedup keys with check-in or DLQ-tracker keys.
 */

import type { Redis } from '@upstash/redis';

/** Default TTL — exactly 24 h, the minimum mandated by Req 17.4. */
export const DEFAULT_DEDUP_TTL_SEC = 24 * 60 * 60;

/** Redis key prefix for the seen-set. Stable wire contract — operators
 *  reading Redis directly (e.g. `redis-cli SCAN MATCH 'events:seen:*'`)
 *  rely on it. Bumping the prefix is a breaking change. */
export const DEFAULT_DEDUP_PREFIX = 'events:seen';

/**
 * Atomically record an `eventId` as "seen" and report whether the
 * caller is the first to do so.
 *
 * Returns `true` when the key was freshly created — the caller MUST
 * proceed with the side effect. Returns `false` when the key already
 * existed — the caller MUST skip and ack the message.
 *
 * The implementation is a single `SET key '1' NX EX <ttl>` command.
 * Upstash returns:
 *   - `'OK'` (cast through unknown) when the write took place,
 *   - `null` when `NX` rejected the write because the key existed.
 *
 * Per-replica races are safe: only the first `SET NX` to land at
 * Upstash returns `'OK'`; the others see `null` and skip.
 *
 * @param redis      Authenticated Upstash client.
 * @param eventId    Domain-level event id (UUID, the `id` field of
 *                   the parsed envelope). Must be a non-empty string.
 * @param ttlSec     TTL in seconds. Defaults to {@link DEFAULT_DEDUP_TTL_SEC}.
 * @param prefix     Key prefix. Defaults to {@link DEFAULT_DEDUP_PREFIX}.
 * @returns          `true` if the event was unseen and is now marked,
 *                   `false` if it was already seen within the window.
 *
 * @throws {TypeError}  when `eventId` is not a non-empty string.
 * @throws {RangeError} when `ttlSec` is not a finite positive number.
 */
export async function assertNotSeen(
    redis: Redis,
    eventId: string,
    ttlSec: number = DEFAULT_DEDUP_TTL_SEC,
    prefix: string = DEFAULT_DEDUP_PREFIX,
): Promise<boolean> {
    if (typeof eventId !== 'string' || eventId.length === 0) {
        throw new TypeError('assertNotSeen: eventId must be a non-empty string');
    }
    if (typeof prefix !== 'string' || prefix.length === 0) {
        throw new TypeError('assertNotSeen: prefix must be a non-empty string');
    }
    if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
        throw new RangeError(
            `assertNotSeen: ttlSec must be > 0, got ${String(ttlSec)}`,
        );
    }

    // Clamp to ≥ 1 second to match Upstash's `EX` lower bound; floor
    // because the protocol does not accept fractional seconds.
    const ex = Math.max(1, Math.floor(ttlSec));
    const key = `${prefix}:${eventId}`;

    // `set` returns the literal string `'OK'` on a successful write
    // and `null` when `NX` blocks the write. Both branches are typed
    // through the Upstash client's overloads; the cast keeps the
    // compiler honest without forcing the consumer to discriminate.
    const result = (await redis.set(key, '1', { ex, nx: true })) as
        | 'OK'
        | null
        | undefined;

    return result === 'OK';
}
