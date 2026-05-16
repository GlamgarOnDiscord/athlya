/**
 * Unit tests for the Cloudflare Turnstile verification middleware
 * (task 8.9).
 *
 * Exercises the behaviour described in the file header of
 * `middleware/turnstile.ts`:
 *
 *   1. Happy path â€” valid token + `success: true` siteverify â†’ next()
 *      called, no response emitted.
 *   2. Missing `cf-turnstile-token` header â†’ 403 `bot_challenge_failed`,
 *      next() NOT called.
 *   3. Empty `cf-turnstile-token` header â†’ 403.
 *   4. Siteverify returns `success: false` â†’ 403, warn logged with
 *      the Cloudflare error-codes.
 *   5. Siteverify returns non-2xx â†’ 403.
 *   6. Fetch rejects (simulated network down) â†’ 403 (fail closed).
 *   7. Fetch times out â†’ 403, error logged as timeout.
 *   8. Dev env without `TURNSTILE_SECRET` â†’ warn logged, next() called.
 *   9. Staging env without `TURNSTILE_SECRET` â†’ 500 `configuration_error`.
 *  10. Production env without `TURNSTILE_SECRET` â†’ 500.
 *  11. Request body contract â€” `secret`, `response`, `remoteip`
 *      (from CF-Connecting-IP) are posted as form fields.
 *  12. Every error response carries `content-type:
 *      application/problem+json`.
 *
 * Every test injects `fetch` through the factory option. `vi.stubGlobal`
 * is deliberately avoided so we can run multiple middleware instances
 * in the same file with independent fakes.
 *
 * Validates: Requirements 26.1, 26.2, 26.3.
 */

import { describe, expect, it, vi } from 'vitest';

import { PROBLEM_JSON_CONTENT_TYPE } from '../middleware/problem-details.js';
import {
    CLOUDFLARE_SITEVERIFY_URL,
    TURNSTILE_TOKEN_HEADER,
    turnstile,
    type TurnstileContext,
} from '../middleware/turnstile.js';

import type { AthlyaEnvironment } from '../types.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Logger fake implementing the {@link ProblemLogger} surface. Each
 * method is a Vitest spy so tests can assert on the log calls the
 * middleware emits. `info` / `debug` are not part of the interface
 * the middleware uses but are included for defensive future-proofing.
 */
function fakeLogger(): {
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
} {
    return {
        warn: vi.fn(),
        error: vi.fn(),
    };
}

/**
 * Build a fake Hono context that satisfies {@link TurnstileContext}
 * structurally. Headers, environment and variables are passed as
 * plain records; the returned `body` is a Vitest spy so tests can
 * assert on the exact arguments it received.
 */
function fakeContext(args: {
    environment?: AthlyaEnvironment;
    secret?: string | undefined;
    headers?: Record<string, string>;
    variables?: Record<string, unknown>;
}): TurnstileContext & {
    body: ReturnType<typeof vi.fn>;
} {
    const env: {
        ENVIRONMENT: AthlyaEnvironment;
        TURNSTILE_SECRET?: string;
    } = {
        ENVIRONMENT: args.environment ?? 'production',
    };
    if (args.secret !== undefined) {
        env.TURNSTILE_SECRET = args.secret;
    }

    const headers = new Map<string, string>(
        Object.entries(args.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const variables = args.variables ?? {};

    // `body` must return a real Response instance because Hono's
    // contract does â€” the middleware chains on that assumption.
    const body = vi.fn((data: string, status: number, respHeaders: Record<string, string>) => {
        return new Response(data, {
            status,
            headers: respHeaders,
        });
    });

    return {
        env,
        req: {
            header(name: string): string | undefined {
                return headers.get(name.toLowerCase());
            },
        },
        get(key: 'traceId' | 'logger'): unknown {
            return variables[key];
        },
        body,
    };
}

/**
 * Build a `fetch` fake that returns a canned `Response`. Used for the
 * success and rejection branches.
 */
function fakeFetch(response: Response): ReturnType<typeof vi.fn> {
    return vi.fn(() => Promise.resolve(response));
}

/**
 * Build a `fetch` fake that throws synchronously after being awaited â€”
 * emulates a network / DNS / TLS failure.
 */
function rejectingFetch(err: unknown): ReturnType<typeof vi.fn> {
    return vi.fn(() => Promise.reject(err));
}

/**
 * Build a `fetch` fake that waits indefinitely, giving the middleware's
 * AbortController time to fire. The returned spy captures the abort
 * signal and rejects with an `AbortError` the moment `signal.abort()`
 * is observed â€” this mirrors the real `fetch` behaviour on Workers
 * without relying on wall-clock time.
 */
function hangingFetch(): ReturnType<typeof vi.fn> {
    return vi.fn((_input: unknown, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted === true) {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
                return;
            }
            signal?.addEventListener(
                'abort',
                () => {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    reject(err);
                },
                { once: true },
            );
        });
    });
}

/** Build a success response. */
function siteverifySuccess(): Response {
    return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

/** Build a failure response with explicit error codes. */
function siteverifyFailure(errorCodes: readonly string[]): Response {
    return new Response(
        JSON.stringify({
            success: false,
            'error-codes': errorCodes,
        }),
        {
            status: 200,
            headers: { 'content-type': 'application/json' },
        },
    );
}

/** Parse a problem-details Response into its body + status tuple. */
async function readProblemBody(
    response: Response,
): Promise<{ status: number; body: Record<string, unknown>; contentType: string | null }> {
    const contentType = response.headers.get('content-type');
    const body = await response.json() as Record<string, unknown>;
    return { status: response.status, body, contentType };
}

/* ------------------------------------------------------------------ */
/*  Happy path                                                         */
/* ------------------------------------------------------------------ */

describe('turnstile â€” happy path', () => {
    it('calls next() when siteverify returns success:true and does NOT emit a response', async () => {
        const c = fakeContext({
            environment: 'production',
            secret: 'test-secret',
            headers: {
                [TURNSTILE_TOKEN_HEADER]: 'abc-123',
                'CF-Connecting-IP': '203.0.113.9',
            },
            variables: { traceId: 't-happy', logger: fakeLogger() },
        });
        const fetchSpy = fakeFetch(siteverifySuccess());
        const next = vi.fn().mockResolvedValue(undefined);

        const mw = turnstile({ fetch: fetchSpy });
        const out = await mw(c, next);

        expect(out).toBeUndefined();
        expect(next).toHaveBeenCalledTimes(1);
        expect(c.body).not.toHaveBeenCalled();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
});

/* ------------------------------------------------------------------ */
/*  Missing / empty token                                              */
/* ------------------------------------------------------------------ */

describe('turnstile â€” missing or empty token', () => {
    it('returns 403 bot_challenge_failed when cf-turnstile-token header is absent, and does NOT call next()', async () => {
        const logger = fakeLogger();
        const c = fakeContext({
            environment: 'production',
            secret: 'test-secret',
            headers: {},
            variables: { traceId: 't-missing', logger },
        });
        const fetchSpy = fakeFetch(siteverifySuccess());
        const next = vi.fn();

        const mw = turnstile({ fetch: fetchSpy });
        const response = await mw(c, next);

        expect(response).toBeInstanceOf(Response);
        const { status, body, contentType } = await readProblemBody(response!);
        expect(status).toBe(403);
        expect(contentType).toBe(PROBLEM_JSON_CONTENT_TYPE);
        expect(body['code']).toBe('bot_challenge_failed');
        expect(body['status']).toBe(403);
        expect(body['traceId']).toBe('t-missing');
        expect(body['title']).toBe('Forbidden');
        expect(next).not.toHaveBeenCalled();
        // Siteverify was never reached.
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            'turnstile token missing',
            expect.objectContaining({ traceId: 't-missing' }),
        );
    });

    it('returns 403 when the cf-turnstile-token header is empty / whitespace', async () => {
        const c = fakeContext({
            environment: 'production',
            secret: 'test-secret',
            headers: { [TURNSTILE_TOKEN_HEADER]: '   ' },
            variables: { traceId: 't-empty', logger: fakeLogger() },
        });
        const fetchSpy = fakeFetch(siteverifySuccess());
        const next = vi.fn();

        const mw = turnstile({ fetch: fetchSpy });
        const response = await mw(c, next);

        expect(response).toBeInstanceOf(Response);
        expect(response!.status).toBe(403);
        expect(next).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

/* ------------------------------------------------------------------ */
/*  Siteverify rejection                                               */
/* ------------------------------------------------------------------ */

describe('turnstile â€” siteverify rejection', () => {
    it('returns 403 when Cloudflare responds with success:false and logs the error-codes at warn level', async () => {
        const logger = fakeLogger();
        const c = fakeContext({
            environment: 'production',
            secret: 'test-secret',
            headers: { [TURNSTILE_TOKEN_HEADER]: 'bad-token' },
            variables: { traceId: 't-fail', logger },
        });
        const errorCodes = ['invalid-input-response', 'timeout-or-duplicate'];
        const fetchSpy = fakeFetch(siteverifyFailure(errorCodes));
        const next = vi.fn();

        const mw = turnstile({ fetch: fetchSpy });
        const response = await mw(c, next);

        expect(response).toBeInstanceOf(Response);
        const { status, body, contentType } = await readProblemBody(response!);
        expect(status).toBe(403);
        expect(contentType).toBe(PROBLEM_JSON_CONTENT_TYPE);
        expect(body['code']).toBe('bot_challenge_failed');
        expect(next).not.toHaveBeenCalled();
        // Error codes land in the log but NOT in the body (anti-probing).
        expect(body).not.toHaveProperty('errorCodes');
        expect(body).not.toHaveProperty('error-codes');
        expect(logger.warn).toHaveBeenCalledWith(
            'turnstile verification rejected',
            expect.objectContaining({
                reason: 'failure',
                errorCodes,
            }),
        );
    });

    it('returns 403 when siteverify responds with a non-2xx status', async () => {
        const logger = fakeLogger();
        const c = fakeContext({
            environment: 'production',
            secret: 'test-secret',
            headers: { [TURNSTILE_TOKEN_HEADER]: 'abc-123' },
            variables: { traceId: 't-5xx', logger },
        });
        const fetchSpy = fakeFetch(
            new Response('server-error', { status: 502 }),
        );
        const next = vi.fn();

        const mw = turnstile({ fetch: fetchSpy });
        const response = await mw(c, next);

        expect(response!.status).toBe(403);
        expect(next).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            'turnstile verification rejected',
            expect.objectContaining({ reason: 'non_2xx', upstreamStatus: 502 }),
        );
    });
});

/* ------------------------------------------------------------------ */
/*  Fetch failure modes                                                */
/* ------------------------------------------------------------------ */

describe('turnstile â€” fetch failure modes', () => {
    it('returns 403 when fetch rejects (network / DNS / TLS error) â€” fails closed', async () => {
        const logger = fakeLogger();
        const c = fakeContext({
            environment: 'production',
            secret: 'test-secret',
            headers: { [TURNSTILE_TOKEN_HEADER]: 'abc-123' },
            variables: { traceId: 't-net', logger },
        });
        const networkErr = new TypeError('fetch failed');
        const fetchSpy = rejectingFetch(networkErr);
        const next = vi.fn();

        const mw = turnstile({ fetch: fetchSpy });
        const response = await mw(c, next);

        expect(response!.status).toBe(403);
        expect(next).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            'turnstile verification network error',
            expect.objectContaining({ traceId: 't-net' }),
        );
    });

    it('returns 403 on timeout and logs the timeout at warn level', async () => {
        const logger = fakeLogger();
        const c = fakeContext({
            environment: 'production',
            secret: 'test-secret',
            headers: { [TURNSTILE_TOKEN_HEADER]: 'abc-123' },
            variables: { traceId: 't-timeout', logger },
        });
        const fetchSpy = hangingFetch();
        const next = vi.fn();

        // Very small timeout so the test is fast but still exercises
        // the real AbortController + setTimeout path.
        const mw = turnstile({ fetch: fetchSpy, timeoutMs: 5 });
        const response = await mw(c, next);

        expect(response!.status).toBe(403);
        expect(next).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            'turnstile verification timed out',
            expect.objectContaining({ traceId: 't-timeout', timeoutMs: 5 }),
        );
    });
});

/* ------------------------------------------------------------------ */
/*  Missing secret behaviour                                           */
/* ------------------------------------------------------------------ */

describe('turnstile â€” missing TURNSTILE_SECRET', () => {
    it('dev env: warn logged and next() called (bypass)', async () => {
        const logger = fakeLogger();
        const c = fakeContext({
            environment: 'dev',
            // secret intentionally left undefined
            headers: { [TURNSTILE_TOKEN_HEADER]: 'abc-123' },
            variables: { traceId: 't-dev', logger },
        });
        const fetchSpy = vi.fn();
        const next = vi.fn().mockResolvedValue(undefined);

        const mw = turnstile({ fetch: fetchSpy });
        const out = await mw(c, next);

        expect(out).toBeUndefined();
        expect(next).toHaveBeenCalledTimes(1);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(c.body).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            'turnstile bypassed in dev',
            expect.objectContaining({ traceId: 't-dev' }),
        );
    });

    it('staging env: 500 Problem Details configuration_error', async () => {
        const logger = fakeLogger();
        const c = fakeContext({
            environment: 'staging',
            headers: { [TURNSTILE_TOKEN_HEADER]: 'abc-123' },
            variables: { traceId: 't-stg', logger },
        });
        const fetchSpy = vi.fn();
        const next = vi.fn();

        const mw = turnstile({ fetch: fetchSpy });
        const response = await mw(c, next);

        expect(response).toBeInstanceOf(Response);
        const { status, body, contentType } = await readProblemBody(response!);
        expect(status).toBe(500);
        expect(contentType).toBe(PROBLEM_JSON_CONTENT_TYPE);
        expect(body['code']).toBe('configuration_error');
        expect(body['status']).toBe(500);
        expect(body['title']).toBe('Internal Server Error');
        expect(body['traceId']).toBe('t-stg');
        expect(next).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
            'turnstile secret missing',
            expect.objectContaining({ environment: 'staging' }),
        );
    });

    it('production env: 500 Problem Details configuration_error', async () => {
        const c = fakeContext({
            environment: 'production',
            headers: { [TURNSTILE_TOKEN_HEADER]: 'abc-123' },
            variables: { traceId: 't-prod', logger: fakeLogger() },
        });
        const fetchSpy = vi.fn();
        const next = vi.fn();

        const mw = turnstile({ fetch: fetchSpy });
        const response = await mw(c, next);

        expect(response!.status).toBe(500);
        expect(next).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

/* ------------------------------------------------------------------ */
/*  Request body contract                                              */
/* ------------------------------------------------------------------ */

describe('turnstile â€” siteverify request shape', () => {
    it('posts secret, response and remoteip (from CF-Connecting-IP) as application/x-www-form-urlencoded', async () => {
        const c = fakeContext({
            environment: 'production',
            secret: 'super-secret',
            headers: {
                [TURNSTILE_TOKEN_HEADER]: 'token-xyz',
                'CF-Connecting-IP': '198.51.100.7',
            },
            variables: { traceId: 't-body', logger: fakeLogger() },
        });
        const fetchSpy = fakeFetch(siteverifySuccess());
        const next = vi.fn().mockResolvedValue(undefined);

        const mw = turnstile({ fetch: fetchSpy });
        await mw(c, next);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const call = fetchSpy.mock.calls[0];
        expect(call).toBeDefined();
        const [url, init] = call as [string, RequestInit];

        expect(url).toBe(CLOUDFLARE_SITEVERIFY_URL);
        expect(init.method).toBe('POST');
        const ctHeader = (init.headers as Record<string, string>)['content-type'];
        expect(ctHeader).toBe('application/x-www-form-urlencoded');

        const params = new URLSearchParams(init.body as string);
        expect(params.get('secret')).toBe('super-secret');
        expect(params.get('response')).toBe('token-xyz');
        expect(params.get('remoteip')).toBe('198.51.100.7');
    });

    it('omits remoteip when CF-Connecting-IP is not set', async () => {
        const c = fakeContext({
            environment: 'production',
            secret: 's',
            headers: { [TURNSTILE_TOKEN_HEADER]: 'tok' },
            variables: { traceId: 't-noip', logger: fakeLogger() },
        });
        const fetchSpy = fakeFetch(siteverifySuccess());
        const next = vi.fn().mockResolvedValue(undefined);

        const mw = turnstile({ fetch: fetchSpy });
        await mw(c, next);

        const call = fetchSpy.mock.calls[0];
        const [, init] = call as [string, RequestInit];
        const params = new URLSearchParams(init.body as string);
        expect(params.has('remoteip')).toBe(false);
        expect(params.get('secret')).toBe('s');
        expect(params.get('response')).toBe('tok');
    });
});

/* ------------------------------------------------------------------ */
/*  Content-type invariant                                             */
/* ------------------------------------------------------------------ */

describe('turnstile â€” response content-type', () => {
    it('every error response is application/problem+json', async () => {
        const scenarios: Array<{
            name: string;
            build: () => Promise<Response>;
        }> = [
                {
                    name: 'missing token',
                    build: async () => {
                        const c = fakeContext({
                            environment: 'production',
                            secret: 's',
                            headers: {},
                            variables: { traceId: 't-ct1', logger: fakeLogger() },
                        });
                        const mw = turnstile({
                            fetch: fakeFetch(siteverifySuccess()),
                        });
                        const r = await mw(c, vi.fn());
                        return r as Response;
                    },
                },
                {
                    name: 'siteverify failure',
                    build: async () => {
                        const c = fakeContext({
                            environment: 'production',
                            secret: 's',
                            headers: { [TURNSTILE_TOKEN_HEADER]: 'bad' },
                            variables: { traceId: 't-ct2', logger: fakeLogger() },
                        });
                        const mw = turnstile({
                            fetch: fakeFetch(siteverifyFailure(['x'])),
                        });
                        const r = await mw(c, vi.fn());
                        return r as Response;
                    },
                },
                {
                    name: 'missing secret in production',
                    build: async () => {
                        const c = fakeContext({
                            environment: 'production',
                            headers: { [TURNSTILE_TOKEN_HEADER]: 't' },
                            variables: { traceId: 't-ct3', logger: fakeLogger() },
                        });
                        const mw = turnstile({
                            fetch: fakeFetch(siteverifySuccess()),
                        });
                        const r = await mw(c, vi.fn());
                        return r as Response;
                    },
                },
            ];

        for (const scenario of scenarios) {
            const response = await scenario.build();
            expect(
                response.headers.get('content-type'),
                `scenario: ${scenario.name}`,
            ).toBe(PROBLEM_JSON_CONTENT_TYPE);
        }
    });
});
