/**
 * Redis in-flight marker for the strict idempotency mode
 * (`IdempotencyInFlightLock`): `SET key token NX EX ttl` to take it,
 * and a token-checked delete to release it, so a marker that expired
 * and was taken by another request is never dropped by the first one.
 */

import type { IdempotencyInFlightLock } from '../middleware/idempotency.js';
import type { Redis } from '@upstash/redis';

/** Delete `KEYS[1]` only while it still holds the caller's token. */
const RELEASE_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

export function createRedisInFlightLock(
  redis: Pick<Redis, 'set' | 'eval'>,
): IdempotencyInFlightLock {
  return {
    async acquire(key, token, ttlSec) {
      const result = await redis.set(key, token, { nx: true, ex: ttlSec });
      return result === 'OK';
    },
    async release(key, token) {
      await redis.eval(RELEASE_SCRIPT, [key], [token]);
    },
  };
}
