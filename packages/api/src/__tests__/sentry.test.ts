/**
 * Unit tests for the Sentry capture client — task 8.7.
 *
 * Validates Requirement 30.3 at the client level:
 *
 *   1. No-op when DSN is empty / undefined: no fetch, no throw,
 *      a single `warn` on the first call.
 *   2. Real client builds the correct envelope:
 *       - POST to `<ingestBase>/api/<projectId>/envelope/`
 *       - `x-sentry-auth` header carries `sentry_key=<publicKey>`
 *         and `sentry_version=7`
 *       - body is 3 newline-separated JSON lines (header, item
 *         header, item payload)
 *   3. `traceId` surfaces as `tags.trace_id` on the event.
 *   4. Transport failures are swallowed: the returned promise still
 *      resolves, no exception reaches the caller.
 *   5. A non-Error throw (string) is normalised, not dropped.
 */

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type MockInstance,
} from 'vitest';

import {
    __resetSentryCacheForTests,
    captureUnhandled,
    createSentryClient,
    type SentryClient,
} from '../sentry.js';

const DSN =
    'https://abcdef0123456789abcdef0123456789@o12345.ingest.sentry.io/4504321';

/** Parse the body produced by the client into its 3 envelope lines. */
function parseEnvelopeBody(body: string): {
    header: Record<string, unknown>;
    itemHeader: Record<string, unknown>;
    payload: Record<string, unknown>;
} {
    const lines = body.split('\n');
    expect(lines).toHaveLength(3);
    return {
        header: JSON.parse(lines[0]!) as Record<string, unknown>,
        itemHeader: JSON.parse(lines[1]!) as Record<string, unknown>,
        payload: JSON.parse(lines[2]!) as Record<string, unknown>,
    };
}

describe('createSentryClient — no-op', () => {
    let warnSpy: MockInstance;

    beforeEach(() => {
        __resetSentryCacheForTests();
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns a no-op client when DSN is undefined', async () => {
        const fetchSpy = vi.fn<typeof fetch>();
        const client = createSentryClient({
            environment: 'dev',
            fetch: fetchSpy,
        });

        await expect(
            client.captureException(new Error('boom')),
        ).resolves.toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('returns a no-op client when DSN is the empty string', async () => {
        const fetchSpy = vi.fn<typeof fetch>();
        const client = createSentryClient({
            dsn: '',
            environment: 'dev',
            fetch: fetchSpy,
        });

        await client.captureException(new Error('boom'));
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns a no-op client when DSN is unparseable', async () => {
        const fetchSpy = vi.fn<typeof fetch>();
        const client = createSentryClient({
            dsn: 'not a url at all',
            environment: 'dev',
            fetch: fetchSpy,
        });

        await client.captureException(new Error('boom'));
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('logs the missing-DSN warning at most once per isolate', () => {
        createSentryClient({ environment: 'dev' });
        createSentryClient({ environment: 'dev' });
        createSentryClient({ environment: 'staging' });

        expect(warnSpy).toHaveBeenCalledTimes(1);
    });
});

describe('createSentryClient — envelope', () => {
    let client: SentryClient;
    let fetchSpy: MockInstance<typeof fetch>;

    beforeEach(() => {
        __resetSentryCacheForTests();
        const ok = new Response('{}', { status: 200 });
        fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(ok);
        client = createSentryClient({
            dsn: DSN,
            environment: 'production',
            release: 'athlya-api@0.1.0',
            fetch: fetchSpy as unknown as typeof fetch,
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('POSTs to the envelope endpoint derived from the DSN', async () => {
        await client.captureException(new Error('boom'));

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(String(url)).toBe(
            'https://o12345.ingest.sentry.io/api/4504321/envelope/',
        );
        expect((init as RequestInit).method).toBe('POST');

        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers['content-type']).toBe('application/x-sentry-envelope');
        expect(headers['x-sentry-auth']).toContain(
            'sentry_key=abcdef0123456789abcdef0123456789',
        );
        expect(headers['x-sentry-auth']).toContain('sentry_version=7');
    });

    it('serialises the body as three newline-separated JSON lines', async () => {
        await client.captureException(new Error('boom'));

        const body = (fetchSpy.mock.calls[0]![1] as RequestInit).body as string;
        const { header, itemHeader, payload } = parseEnvelopeBody(body);

        expect(header).toMatchObject({ dsn: DSN });
        expect(typeof header['event_id']).toBe('string');
        expect(typeof header['sent_at']).toBe('string');

        expect(itemHeader).toEqual({ type: 'event' });

        expect(payload['platform']).toBe('javascript');
        expect(payload['level']).toBe('error');
        expect(payload['environment']).toBe('production');
        expect(payload['release']).toBe('athlya-api@0.1.0');
        expect(payload['exception']).toEqual({
            values: [{ type: 'Error', value: 'boom' }],
        });
    });

    it('exposes traceId as tags.trace_id', async () => {
        await client.captureException(new Error('boom'), {
            traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
            tags: { path: '/v1/reservations', status: '500' },
        });

        const body = (fetchSpy.mock.calls[0]![1] as RequestInit).body as string;
        const { payload } = parseEnvelopeBody(body);
        const tags = payload['tags'] as Record<string, string>;
        expect(tags['trace_id']).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
        expect(tags['path']).toBe('/v1/reservations');
        expect(tags['status']).toBe('500');
        // The env tag is always merged in from the factory config.
        expect(tags['env']).toBe('production');
    });

    it('normalises non-Error throws so the envelope is still valid', async () => {
        await client.captureException('a plain string failure');

        const body = (fetchSpy.mock.calls[0]![1] as RequestInit).body as string;
        const { payload } = parseEnvelopeBody(body);
        expect(payload['exception']).toEqual({
            values: [
                { type: 'NonErrorThrow', value: 'a plain string failure' },
            ],
        });
    });

    it('swallows a transport failure and still resolves', async () => {
        fetchSpy.mockRejectedValueOnce(new Error('network down'));

        // No throw expected, and the returned promise resolves cleanly.
        await expect(
            client.captureException(new Error('boom')),
        ).resolves.toBeUndefined();
    });

    it('swallows a JSON-serialisation failure on extra and still resolves', async () => {
        const circular: Record<string, unknown> = {};
        circular['self'] = circular;

        await expect(
            client.captureException(new Error('boom'), {
                extra: { circular },
            }),
        ).resolves.toBeUndefined();
    });
});

describe('captureUnhandled — Hono integration helper', () => {
    beforeEach(() => {
        __resetSentryCacheForTests();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reads traceId from the context and forwards env / path / method as tags', async () => {
        const ok = new Response('{}', { status: 200 });
        const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(ok);

        // Monkey-patch the global fetch for the factory path the
        // helper goes through. `captureUnhandled` creates the client
        // without injecting fetch, so we substitute it on the global.
        const originalFetch = globalThis.fetch;
        (globalThis as { fetch: typeof fetch }).fetch =
            fetchSpy;

        try {
            await captureUnhandled(new Error('boom'), {
                env: {
                    ENVIRONMENT: 'staging',
                    SENTRY_DSN: DSN,
                    VERSION: 'v1',
                },
                req: { path: '/v1/reservations', method: 'POST' },
                get: () => '4bf92f3577b34da6a3ce929d0e0e4736',
            });
        } finally {
            (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
        }

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const body = (fetchSpy.mock.calls[0]![1] as RequestInit).body as string;
        const { payload } = parseEnvelopeBody(body);
        const tags = payload['tags'] as Record<string, string>;
        expect(tags['trace_id']).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
        expect(tags['path']).toBe('/v1/reservations');
        expect(tags['method']).toBe('POST');
        expect(tags['env']).toBe('staging');
    });

    it('is a no-op when SENTRY_DSN is absent on the bindings', async () => {
        const fetchSpy = vi.fn<typeof fetch>();
        const originalFetch = globalThis.fetch;
        (globalThis as { fetch: typeof fetch }).fetch =
            fetchSpy;

        try {
            await captureUnhandled(new Error('boom'), {
                env: { ENVIRONMENT: 'dev' },
                req: { path: '/health' },
                get: () => 'trace',
            });
        } finally {
            (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
        }

        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
