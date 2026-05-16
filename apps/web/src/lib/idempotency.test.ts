/**
 * Unit tests for the web app's idempotency-key helper.
 *
 * The helper is a thin wrapper around `crypto.randomUUID()`; we're
 * not re-testing the platform's RNG, just the contract the Hono
 * gateway relies on (Req 20.1 / 20.3):
 *   - shape matches UUID v4 (`xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx`),
 *   - consecutive calls produce distinct values.
 */
import { describe, expect, it } from 'vitest';

import { newIdempotencyKey } from './idempotency';

/** RFC 4122 v4 UUID — 8-4-4-4-12 hex, variant bits `10xx`. */
const UUID_V4 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe('newIdempotencyKey', () => {
    it('returns a UUID v4 and successive calls differ', () => {
        const a = newIdempotencyKey();
        const b = newIdempotencyKey();

        expect(a).toMatch(UUID_V4);
        expect(b).toMatch(UUID_V4);
        expect(a).not.toBe(b);
    });
});
