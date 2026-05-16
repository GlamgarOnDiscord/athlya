/**
 * Idempotency key generator for mutating requests against the API.
 * Same shape as `apps/web/src/lib/idempotency.ts`.
 */

export function newIdempotencyKey(): string {
    return crypto.randomUUID();
}
