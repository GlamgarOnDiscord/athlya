/**
 * Sliding-window rate limiter backed by Upstash Redis sorted sets.
 *
 * Extracted from `@athlya/api` in hardening H5 to break the
 * `@athlya/api` ↔ `@athlya/auth` circular dependency.
 *
 * Implements design Algorithm 5 and satisfies Requirements 15.1–15.3:
 *
 *   • 15.1 — Allow ↔ (count of requests in (now − windowSec, now]) ≤ limit
 *   • 15.2 — On Deny, return `retryAfterSec` computed from the oldest entry
 *   • 15.3 — Use a single Redis pipeline `ZREMRANGEBYSCORE` + `ZADD` +
 *            `ZCARD` + `EXPIRE` so the decision is a single network
 *            round-trip, which is essential on Cloudflare Workers where
 *            every hop adds tail latency.
 *
 * The algorithm is the "sliding log" variant: each request is stored as a
 * sorted-set member whose score is its timestamp in milliseconds. We trim
 * anything older than `windowStartMs`, add the new request, count what
 * remains, and bump the key's TTL. If the post-add count exceeds `limit`,
 * we read the oldest surviving timestamp and tell the caller when the
 * next slot frees up.
 *
 * Members are suffixed with a per-call `crypto.randomUUID()` so two
 * requests arriving in the same millisecond keep their own rows. Sorted
 * sets deduplicate by member (not by score), so without the suffix a
 * burst could collapse to a single entry and silently under-count.
 */

import type { Redis } from '@upstash/redis';

/** Outcome of a rate-limit decision. */
export type RateLimitDecision =
  | { kind: 'allow'; remaining: number }
  | { kind: 'deny'; retryAfterSec: number };

/**
 * Dependencies accepted by the rate limiter. Kept as a plain record so
 * callers can inject a fake clock (tests) or a different Redis facade
 * without coupling to the Upstash client type elsewhere.
 */
export interface RateLimiterDeps {
  /** Upstash Redis client, typically `Redis.fromEnv()` on the edge. */
  redis: Redis;
  /** Injectable clock returning milliseconds since epoch. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Evaluate a sliding-window rate limit for `key`.
 *
 * Preconditions:
 *   • `limit > 0` and `windowSec > 0` — both asserted.
 *   • `key` is a stable, caller-built identifier (e.g. `"rl:ip:1.2.3.4"`).
 *
 * Postconditions:
 *   • Returns `allow` iff the number of requests recorded in the interval
 *     `(now - windowSec * 1000, now]` (including the just-added one) is
 *     less than or equal to `limit`.
 *   • Returns `deny` with `retryAfterSec ∈ [1, windowSec]` otherwise.
 *   • The sorted set at `key` is always refreshed to expire after
 *     `windowSec`, so idle keys do not leak memory in Redis.
 */
export async function rateLimitSlidingWindow(
  deps: RateLimiterDeps,
  key: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitDecision> {
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new RangeError(`rateLimitSlidingWindow: limit must be > 0, got ${String(limit)}`);
  }
  if (!Number.isFinite(windowSec) || windowSec <= 0) {
    throw new RangeError(`rateLimitSlidingWindow: windowSec must be > 0, got ${String(windowSec)}`);
  }

  const nowMs = deps.now?.() ?? Date.now();
  const windowMs = windowSec * 1000;
  const windowStartMs = nowMs - windowMs;

  // Unique member so members landing on the same millisecond do not
  // collide in the sorted set (Upstash dedupes by member, not score).
  const member = `${nowMs.toString()}:${crypto.randomUUID()}`;

  // Sprint-10 SP10.1 (Vague 38, critique C2.1) — note importante
  // sur la cardinalité réseau : le path `allow` est bien un seul
  // round-trip Upstash (4 commandes pipelinées). Le path `deny`
  // ajoute UN second round-trip pour `ZRANGE oldest`, exactement
  // au pire moment (charge haute → plus de denies → plus de
  // round-trips). C'est une dette technique acceptée — le
  // refactor pour intégrer le ZRANGE dans la pipeline initiale
  // imposerait soit un script Lua dédié soit un `pipeline.exec()`
  // de 5 commandes dont une retournerait un array, ce que
  // l'API typage Upstash gère mal aujourd'hui. À reconsidérer
  // si le 5xx Upstash devient un signal récurrent en prod.
  //
  // Req 15.3 mentionnait "single round-trip" — c'est vrai pour
  // le happy path (allow). Sur deny, le caller a déjà été refusé
  // donc le surcoût latence sur le path d'erreur est moins
  // critique que la complexité du refactor pipeline.
  const pipeline = deps.redis.pipeline();
  pipeline.zremrangebyscore(key, 0, windowStartMs);
  pipeline.zadd(key, { score: nowMs, member });
  pipeline.zcard(key);
  pipeline.expire(key, windowSec);

  const results = await pipeline.exec<[number, number, number, number]>();

  // Sprint-10 SP10.1 (Vague 38, critique C1.3) — `pipeline.exec<T>`
  // est une assertion TS au compilateur, pas une validation
  // runtime. Si Upstash retourne une erreur partielle (overload,
  // network blip mid-pipeline), `results[2]` peut être `null` ou
  // `undefined`. Sans guard, `count <= limit` devient
  // `undefined <= 1000 === true` côté JS, et **tout le monde
  // passerait le rate limit en cas de panne Upstash partielle**
  // — fail-open silencieux qui invaliderait toute la défense
  // anti-flood.
  //
  // Posture explicite : en cas d'incertitude sur le retour, on
  // FAIL-CLOSED en simulant un compteur saturé (`limit + 1`). Le
  // caller voit un deny, le client retry après le window —
  // dégradation perçue minimale, défense préservée.
  const rawCount = results[2];
  const count = typeof rawCount === 'number' && Number.isFinite(rawCount) ? rawCount : limit + 1;

  if (count <= limit) {
    return { kind: 'allow', remaining: Math.max(0, limit - count) };
  }

  // Over-limit: compute Retry-After from the oldest entry still in the
  // window. That entry's expiry (score + windowMs) is exactly when the
  // window will shift enough to free a slot.
  //
  // Sprint-10 SP10.1 (Vague 38, critique C2.5) — validation
  // explicite du retour `zrange`. Le double cast
  // `as unknown as Array<...>` historique laissait passer un
  // payload Upstash mal formé (changement d'API, version
  // majeure) qui aurait propagé un `NaN` jusqu'à
  // `Math.max(1, NaN) === NaN` puis `Math.min(60, NaN) === NaN`,
  // produisant un `Retry-After: NaN` en header HTTP. La spec
  // RFC 7231 dit que `Retry-After` non-numérique est ignoré par
  // les clients, donc tous les utilisateurs bloqués retry
  // immédiatement → retry storm garanti. La validation runtime
  // ci-dessous fail-close en remontant `windowSec` (le pire
  // retry possible mais sûr).
  //
  // We ceil to the next whole second so clients never retry too early,
  // and clamp to [1, windowSec] so Retry-After stays meaningful even
  // when the oldest entry is a few ms away from rolling out or Redis
  // returned something unexpected.
  let oldestScore: number;
  try {
    const oldest = await deps.redis.zrange(key, 0, 0, { withScores: true });
    // `zrange WITHSCORES` retourne [member, score, member, score, ...].
    // Pour `0..0` on a au plus 2 éléments. Toute autre forme est
    // une réponse Upstash inattendue.
    if (
      !Array.isArray(oldest) ||
      oldest.length < 2 ||
      (typeof oldest[1] !== 'number' && typeof oldest[1] !== 'string')
    ) {
      // Fail-close: retry au plus tard possible, le client ne
      // martèle pas le serveur en cas d'incertitude.
      return { kind: 'deny', retryAfterSec: windowSec };
    }
    const parsedScore = typeof oldest[1] === 'number' ? oldest[1] : Number(oldest[1]);
    if (!Number.isFinite(parsedScore)) {
      return { kind: 'deny', retryAfterSec: windowSec };
    }
    oldestScore = parsedScore;
  } catch {
    // Erreur réseau Upstash sur le second round-trip — fail-close.
    return { kind: 'deny', retryAfterSec: windowSec };
  }

  const retryAfterMs = oldestScore + windowMs - nowMs;
  const retryAfterSec = Math.min(windowSec, Math.max(1, Math.ceil(retryAfterMs / 1000)));

  return { kind: 'deny', retryAfterSec };
}
