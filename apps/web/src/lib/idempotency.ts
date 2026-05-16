/**
 * Idempotency key generator for mutating `PATCH` / `POST` / `DELETE`
 * requests that hit the Athlya API.
 *
 * The Hono gateway pairs a client-generated UUID v4 with the request
 * payload hash and stores the result in Redis (Requirement 20.3 / 8.5).
 * A retry with the same key returns the cached response instead of
 * re-applying the mutation, which is how we keep bookings, profile
 * patches and consent updates exactly-once even across flaky mobile
 * networks.
 *
 * The browser's native `crypto.randomUUID()` is available in every
 * target (modern desktop browsers, Next.js edge runtime, jsdom under
 * Vitest) — no polyfill required.
 */

/**
 * Generate a fresh UUID v4 suitable for the `Idempotency-Key` HTTP
 * header. Returns a 36-character string matching `8-4-4-4-12`.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
