/**
 * Redis-backed implementation of `loginAnomalyStore`.
 *
 * Sprint 12 / Slice 12.15 (Epic B3.4) — persists the user's last
 * known login signal (country + UA family) so the auth service can
 * detect anomalies on subsequent logins and emit
 * `auth.suspicious.login.anomaly`.
 *
 * Redis layout
 * ------------
 *   key: `auth:lastlogin:<userId>`
 *   value: JSON `{ "country": "FR", "uaFamily": "chrome" }`
 *   TTL: 90 days (signals older than that are dropped — the
 *        baseline resets and the next login becomes the new
 *        reference).
 *
 * The TTL bounds storage cost on Upstash: a fixed 256 bytes per
 * row × ~10k DAU = 2.5 MB resident, refreshed every login. Going
 * unbounded would let abandoned accounts accrete forever.
 *
 * The store uses the shared `getOrCreateRedis` per-isolate cache so
 * it does NOT open a fresh connection per call.
 */

import type { LoginSignal } from '@athlya/auth';
import type { Redis } from '@upstash/redis';

/** Redis key prefix for the per-user signal. */
export const LOGIN_ANOMALY_KEY_PREFIX = 'auth:lastlogin';

/** TTL on each signal — 90 days, in seconds. */
export const LOGIN_ANOMALY_TTL_SEC = 90 * 24 * 60 * 60;

/** Build a Redis-backed `loginAnomalyStore`. */
export function createRedisLoginAnomalyStore(redis: Redis): {
    getSignal(userId: string): Promise<LoginSignal | null>;
    setSignal(userId: string, signal: LoginSignal): Promise<void>;
} {
    return {
        async getSignal(userId) {
            const key = `${LOGIN_ANOMALY_KEY_PREFIX}:${userId}`;
            const raw = await redis.get<string>(key);
            if (raw === null || raw === undefined) return null;
            // Upstash auto-deserialises JSON when the value was
            // stored as such; we accept both string-shaped and
            // object-shaped responses.
            if (typeof raw === 'object') {
                const obj = raw as { country?: unknown; uaFamily?: unknown };
                if (
                    typeof obj.country === 'string' &&
                    typeof obj.uaFamily === 'string' &&
                    isUaFamily(obj.uaFamily)
                ) {
                    return {
                        country: obj.country,
                        uaFamily: obj.uaFamily,
                    };
                }
                return null;
            }
            try {
                const parsed = JSON.parse(raw) as {
                    country?: unknown;
                    uaFamily?: unknown;
                };
                if (
                    typeof parsed.country === 'string' &&
                    typeof parsed.uaFamily === 'string' &&
                    isUaFamily(parsed.uaFamily)
                ) {
                    return {
                        country: parsed.country,
                        uaFamily: parsed.uaFamily,
                    };
                }
                return null;
            } catch {
                // Malformed JSON in Redis — treat as missing.
                return null;
            }
        },
        async setSignal(userId, signal) {
            const key = `${LOGIN_ANOMALY_KEY_PREFIX}:${userId}`;
            const value = JSON.stringify(signal);
            // SET with EX TTL refreshes the expiry on every login,
            // so the 90-day window slides forward instead of being
            // anchored on first signal.
            await redis.set(key, value, { ex: LOGIN_ANOMALY_TTL_SEC });
        },
    };
}

/**
 * Type guard for the `uaFamily` enum coming out of Redis. Defends
 * against malicious / stale rows whose `uaFamily` does not match
 * the canonical seven buckets.
 */
function isUaFamily(value: string): value is LoginSignal['uaFamily'] {
    return (
        value === 'chrome' ||
        value === 'firefox' ||
        value === 'safari' ||
        value === 'edge' ||
        value === 'mobile' ||
        value === 'bot' ||
        value === 'other'
    );
}
