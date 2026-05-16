/**
 * Unit tests for {@link computeListEtag} (slice B5).
 *
 * `computeListEtag` is the SHA-256-backed strong ETag builder shared
 * by `GET /v1/classes` (B5.1) and `GET /v1/reservations/me` (B5.2).
 * It MUST satisfy three contracts:
 *
 *   1. Determinism: the same fingerprint yields the same digest, so
 *      a client refreshing without state changes always observes the
 *      same `If-None-Match` value.
 *   2. Sensitivity: a single-character change in the fingerprint
 *      flips the digest. A weakened hash (e.g. a length-only proxy)
 *      would silently break invalidation; this test would surface
 *      the regression immediately.
 *   3. Wire shape: the returned value is wrapped in `"…"` and
 *      contains exactly 16 hex characters, which is the format the
 *      handlers paste straight into the `etag` response header.
 */

import { describe, expect, it } from 'vitest';

import { computeListEtag } from '../../routes/helpers.js';

describe('computeListEtag', () => {
    it('is deterministic for the same fingerprint', async () => {
        const fingerprint =
            'a:1:5:2099-04-01T09:00:00Z|b:2:0:2099-04-02T10:00:00Z';
        const a = await computeListEtag(fingerprint);
        const b = await computeListEtag(fingerprint);
        expect(a).toBe(b);
    });

    it('returns a strong, quoted ETag of 16 hex chars', async () => {
        const etag = await computeListEtag('hello-world');
        expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
        // Strong ETag — no `W/` weak prefix.
        expect(etag.startsWith('W/')).toBe(false);
    });

    it('changes when the fingerprint changes by one character', async () => {
        const a = await computeListEtag('a:1:5:2099-04-01');
        const b = await computeListEtag('a:1:6:2099-04-01');
        expect(a).not.toBe(b);
    });

    it('handles the empty fingerprint without throwing', async () => {
        const etag = await computeListEtag('');
        expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    });
});
