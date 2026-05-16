/**
 * Unit tests for `@athlya/auth/hibp`.
 *
 * We inject a mock `fetch` so the tests are fully deterministic and
 * don't hit the public HIBP endpoint from CI. The three scenarios
 * mirror the behaviours Requirement 1.2 depends on:
 *   1. A suffix present in the response with count > 0 → breached.
 *   2. A suffix absent (or present as a zero-count padding entry) →
 *      not breached.
 *   3. A network failure → {@link HibpUnavailableError} so the service
 *      layer can apply its fail-closed policy.
 *
 * Related requirements: 1.2.
 */

import { describe, expect, it, vi } from 'vitest';

import {
    HIBP_DEFAULT_ENDPOINT,
    HibpUnavailableError,
    hasBreachedSuffix,
    isBreached,
} from '../hibp.js';

// SHA-1('password') = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8 (upper case).
// Prefix = '5BAA6', suffix = '1E4C9B93F3F0682250B6CF8331B7EE68FD8'.
const PWNED_PASSWORD = 'password';
const PWNED_PREFIX = '5BAA6';
const PWNED_SUFFIX = '1E4C9B93F3F0682250B6CF8331B7EE68FD8';

function mockFetchReturning(body: string, status = 200) {
    const impl: typeof fetch = (_url, _init) =>
        Promise.resolve(new Response(body, { status }));
    return vi.fn(impl);
}

describe('hibp.isBreached', () => {
    it('returns true when the suffix is present with count > 0', async () => {
        const fetchMock = mockFetchReturning(
            [
                // Decoy padding entry (count = 0) — must not count as breach.
                '0000000000000000000000000000000000A:0',
                `${PWNED_SUFFIX}:24230577`,
                'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ:42',
            ].join('\r\n'),
        );

        const result = await isBreached(PWNED_PASSWORD, { fetch: fetchMock });
        expect(result).toBe(true);

        // Verify the call shape: correct endpoint + prefix, padding header set.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const call = fetchMock.mock.calls[0];
        expect(call?.[0]).toBe(`${HIBP_DEFAULT_ENDPOINT}/${PWNED_PREFIX}`);
        const init = call?.[1];
        const headers = init?.headers as Record<string, string> | undefined;
        expect(headers?.['Add-Padding']).toBe('true');
    });

    it('returns false when the suffix is absent from the response', async () => {
        const fetchMock = mockFetchReturning(
            [
                'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:17',
                'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB:2',
            ].join('\r\n'),
        );

        const result = await isBreached('an-unbreached-passphrase-🌱', {
            fetch: fetchMock,
        });
        expect(result).toBe(false);
    });

    it('returns false when the suffix is present but padded (count = 0)', async () => {
        const fetchMock = mockFetchReturning(`${PWNED_SUFFIX}:0\n`);

        const result = await isBreached(PWNED_PASSWORD, { fetch: fetchMock });
        expect(result).toBe(false);
    });

    it('matches suffixes case-insensitively', async () => {
        const fetchMock = mockFetchReturning(
            `${PWNED_SUFFIX.toLowerCase()}:9\n`,
        );
        const result = await isBreached(PWNED_PASSWORD, { fetch: fetchMock });
        expect(result).toBe(true);
    });

    it('throws HibpUnavailableError on a network failure', async () => {
        // Sprint 11 / Slice 11.3 — the production path retries 2x
        // by default; we disable retries here so the test exercises
        // a single-attempt failure (and runs in <1ms instead of the
        // ~300 ms with default jittered backoff).
        const impl: typeof fetch = () =>
            Promise.reject(new Error('boom: ECONNRESET'));
        const fetchMock = vi.fn(impl);

        await expect(
            isBreached(PWNED_PASSWORD, {
                fetch: fetchMock,
                retries: 0,
            }),
        ).rejects.toBeInstanceOf(HibpUnavailableError);
        // One attempt only — `retries: 0` disables the loop.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws HibpUnavailableError on a non-OK HTTP status', async () => {
        const fetchMock = mockFetchReturning('service unavailable', 503);

        await expect(
            isBreached(PWNED_PASSWORD, {
                fetch: fetchMock,
                retries: 0,
            }),
        ).rejects.toBeInstanceOf(HibpUnavailableError);
    });

    it('retries on transient network failure and succeeds on the second attempt (Sprint 11 / Slice 11.3)', async () => {
        // First attempt throws; second succeeds. The retry loop
        // must surface the success transparently to the caller.
        let calls = 0;
        const impl: typeof fetch = () => {
            calls += 1;
            if (calls === 1) {
                return Promise.reject(new Error('transient: ECONNRESET'));
            }
            return Promise.resolve(
                new Response(`${PWNED_SUFFIX}:5\n`, { status: 200 }),
            );
        };
        const fetchMock = vi.fn(impl);

        const result = await isBreached(PWNED_PASSWORD, {
            fetch: fetchMock,
            retries: 2,
        });

        expect(result).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries on a 5xx response and succeeds on the second attempt', async () => {
        let calls = 0;
        const impl: typeof fetch = () => {
            calls += 1;
            if (calls === 1) {
                return Promise.resolve(
                    new Response('upstream timeout', { status: 504 }),
                );
            }
            return Promise.resolve(
                new Response(`${PWNED_SUFFIX}:0\n`, { status: 200 }),
            );
        };
        const fetchMock = vi.fn(impl);

        const result = await isBreached(PWNED_PASSWORD, {
            fetch: fetchMock,
            retries: 2,
        });

        // Suffix is padded (count = 0) → not breached.
        expect(result).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry on a non-retryable 4xx response', async () => {
        const fetchMock = mockFetchReturning('forbidden', 403);

        await expect(
            isBreached(PWNED_PASSWORD, {
                fetch: fetchMock,
                retries: 5,
            }),
        ).rejects.toBeInstanceOf(HibpUnavailableError);
        // Single attempt only — 403 is non-retryable.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries on a 429 (rate-limited) response', async () => {
        let calls = 0;
        const impl: typeof fetch = () => {
            calls += 1;
            if (calls === 1) {
                return Promise.resolve(
                    new Response('too many requests', { status: 429 }),
                );
            }
            return Promise.resolve(
                new Response(`AAAAAA:1\n`, { status: 200 }),
            );
        };
        const fetchMock = vi.fn(impl);

        await isBreached(PWNED_PASSWORD, {
            fetch: fetchMock,
            retries: 2,
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('respects the endpoint override', async () => {
        const fetchMock = mockFetchReturning('');
        const custom = 'https://hibp.internal/range';

        await isBreached(PWNED_PASSWORD, {
            fetch: fetchMock,
            endpoint: custom,
        });

        const call = fetchMock.mock.calls[0];
        expect(call?.[0]).toBe(`${custom}/${PWNED_PREFIX}`);
    });
});

describe('hibp.hasBreachedSuffix (pure helper)', () => {
    it('treats CRLF and LF line endings identically', () => {
        const body = `AAA:1\r\n${PWNED_SUFFIX}:5\r\nBBB:2\r\n`;
        expect(hasBreachedSuffix(body, PWNED_SUFFIX)).toBe(true);
    });

    it('ignores blank lines and malformed entries', () => {
        const body = `\n\nnot-a-valid-entry\n${PWNED_SUFFIX}:3\n`;
        expect(hasBreachedSuffix(body, PWNED_SUFFIX)).toBe(true);
    });

    it('returns false when count is zero or non-numeric', () => {
        expect(hasBreachedSuffix(`${PWNED_SUFFIX}:0\n`, PWNED_SUFFIX)).toBe(
            false,
        );
        expect(hasBreachedSuffix(`${PWNED_SUFFIX}:abc\n`, PWNED_SUFFIX)).toBe(
            false,
        );
    });
});
