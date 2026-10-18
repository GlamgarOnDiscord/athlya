/**
 * Upstash Redis `PasswordResetDeliveryStore` (cubic review on #650).
 *
 * One key per event, `auth:password-reset:delivery:{eventId}`, holding
 * `in_flight` (short TTL, taken with `SET NX`) or `completed` (24 h).
 * An in-flight mark left by a crashed isolate expires on its own, so a
 * later retry takes over instead of being acked as a duplicate.
 */

import type {
  DeliveryBegin,
  PasswordResetDeliveryStore,
} from '../events/password-reset-consumer.js';

const PREFIX = 'auth:password-reset:delivery';
const IN_FLIGHT = 'in_flight';
const COMPLETED = 'completed';

/** The subset of the Upstash Redis client used here. */
export interface DeliveryStoreRedis {
  set(key: string, value: string, opts: { nx?: true; ex: number }): Promise<unknown>;
  get(key: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export function createRedisPasswordResetDeliveryStore(
  redis: DeliveryStoreRedis,
): PasswordResetDeliveryStore {
  const keyOf = (eventId: string) => `${PREFIX}:${eventId}`;
  return {
    async begin(eventId, inFlightTtlSec): Promise<DeliveryBegin> {
      const acquired = await redis.set(keyOf(eventId), IN_FLIGHT, {
        nx: true,
        ex: inFlightTtlSec,
      });
      if (acquired === 'OK') return 'acquired';
      return (await redis.get(keyOf(eventId))) === COMPLETED ? 'completed' : 'in_flight';
    },
    async complete(eventId, ttlSec) {
      await redis.set(keyOf(eventId), COMPLETED, { ex: ttlSec });
    },
    async release(eventId) {
      await redis.del(keyOf(eventId));
    },
  };
}
