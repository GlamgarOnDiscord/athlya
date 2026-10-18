/**
 * Upstash Redis `PasswordResetDeliveryStore` (cubic review on #650).
 *
 * One key per event, `auth:password-reset:delivery:{eventId}`, holding
 * `in_flight:<claim>` (short TTL, taken with `SET NX`, `<claim>` unique
 * per attempt) or `completed` (24 h). An in-flight mark left by a crashed
 * isolate expires on its own, so a later retry takes over instead of
 * being acked as a duplicate. `release` deletes the key only while it
 * still holds the caller's claim (compare-and-delete in one Lua call),
 * so a late failing attempt cannot erase a newer attempt's mark or the
 * completed marker.
 */

import type {
  DeliveryBegin,
  PasswordResetDeliveryStore,
} from '../events/password-reset-consumer.js';

const PREFIX = 'auth:password-reset:delivery';
const IN_FLIGHT = 'in_flight';
const COMPLETED = 'completed';

/** Delete KEYS[1] only when it still equals ARGV[1]. */
export const RELEASE_IF_OWNER_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

/** The subset of the Upstash Redis client used here. */
export interface DeliveryStoreRedis {
  set(key: string, value: string, opts: { nx?: true; ex: number }): Promise<unknown>;
  get(key: string): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export function createRedisPasswordResetDeliveryStore(
  redis: DeliveryStoreRedis,
  newClaim: () => string = () => crypto.randomUUID(),
): PasswordResetDeliveryStore {
  const keyOf = (eventId: string) => `${PREFIX}:${eventId}`;
  return {
    async begin(eventId, inFlightTtlSec): Promise<DeliveryBegin> {
      const claim = `${IN_FLIGHT}:${newClaim()}`;
      const acquired = await redis.set(keyOf(eventId), claim, { nx: true, ex: inFlightTtlSec });
      if (acquired === 'OK') return { state: 'acquired', claim };
      const current = await redis.get(keyOf(eventId));
      return current === COMPLETED ? { state: 'completed' } : { state: 'in_flight' };
    },
    async complete(eventId, ttlSec) {
      await redis.set(keyOf(eventId), COMPLETED, { ex: ttlSec });
    },
    async release(eventId, claim) {
      await redis.eval(RELEASE_IF_OWNER_SCRIPT, [keyOf(eventId)], [claim]);
    },
  };
}
