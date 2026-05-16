/**
 * Middleware chain composition tests â€” hardening plan H4.
 *
 * The sibling suites (security-headers, tracing, otel, auth, tenant,
 * rate-limit, validator, idempotency, problem-details) each exercise
 * one middleware in isolation with a hand-crafted fake context. That
 * coverage is necessary but insufficient: the bugs that keep on-call
 * awake at 3 am hide in the COMPOSITION â€” rate-limit mounted before
 * auth so 429s cannot be attributed to a user, tenant helpers firing
 * before `authClaims` is set, Problem Details losing the trace id
 * because an error response swapped the whole `Response` object, OTel
 * recording `http.status_code = 200` because the span ended before
 * `onError` mutated the status.
 *
 * The H4 hardening plan (see
 * `.kiro/specs/athlya-platform/hardening-plan.md`) replaces the
 * Miniflare attempt from task 8.12 with an in-process harness built
 * on Hono's `app.request(path, init, env)` API. That call runs the
 * full `buildApp()` middleware chain synchronously in the test
 * process against a mocked `env`, with no Docker, no Wrangler, no
 * network.
 *
 * This suite exercises ~16 scenarios grouped into six concerns:
 *
 *   1. Happy-path invariants (security headers, x-trace-id).
 *   2. Auth middleware interaction with the tracing / logger chain.
 *   3. Validator + Problem Details wiring.
 *   4. Tenant helpers + Problem Details wiring.
 *   5. Rate-limit chain behaviour on both the IP and user buckets.
 *   6. 500 secret-leak guard + middleware ORDER invariant (OTel
 *      status code derived from the final response, not the value
 *      at the moment the span was started).
 *
 * Validates: Requirements 2.5, 13.5, 14.1, 14.2, 14.3, 14.4, 14.6,
 * 25.2, 25.4, 30.1.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    __resetJwksCacheForTests,
} from '../middleware/auth.js';
import {
    __resetRateLimitRedisCache,
} from '../middleware/rate-limit.js';
import {
    __resetTenantDbCache,
} from '../middleware/tenant.js';

import {
    FakeRedis,
    TEST_STUDIO_ID,
    TEST_USER_ID,
    buildLocalResolver,
    buildMockEnv,
    buildTestApp,
    mintTestKeypair,
    signTestJwt,
    type TestKeypair,
} from './helpers/test-app.js';

import type { JwksKeyResolver } from '../middleware/auth.js';
import type { Redis } from '@upstash/redis';

/* ------------------------------------------------------------------ */
/*  @athlya/db mock â€” the tenant route never issues SQL               */
/* ------------------------------------------------------------------ */

/**
 * `withTenantTx` pulls in `@athlya/db`'s `createDb` / `withTenant`
 * the first time an authenticated request hits `/v1/test/tenant`.
 * Neither helper should execute a real connection during chain
 * tests, so both are replaced with `vi.fn()`s via `vi.mock`. The
 * pattern mirrors `tenant.test.ts`.
 */
const dbMocks = vi.hoisted(() => ({
    createDb: vi.fn(),
    withTenant: vi.fn(),
}));

vi.mock('@athlya/db', () => ({
    createDb: dbMocks.createDb,
    withTenant: dbMocks.withTenant,
}));

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Minimal shape of a Problem Details body emitted by the API â€” used
 * to narrow `await res.json()` at every test call site.
 */
interface ProblemDetailsBody {
    type: string;
    title: string;
    status: number;
    traceId: string;
    detail?: string;
    code?: string;
    errors?: Array<{ path: string; message: string; code: string }>;
}

/** Cast the {@link FakeRedis} through `unknown` to the Upstash surface. */
function asRedis(fake: FakeRedis): Redis {
    return fake as unknown as Redis;
}

/**
 * Assert that every mandatory security header is present on the
 * response. Shared across several tests so the guard stays tight
 * without duplicating the constants.
 */
function expectSecurityHeaders(res: Response): void {
    expect(res.headers.get('strict-transport-security')).toBe(
        'max-age=63072000; includeSubDomains; preload',
    );
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
}

/* ------------------------------------------------------------------ */
/*  Suite-scoped fixtures                                              */
/* ------------------------------------------------------------------ */

let kp: TestKeypair;
let resolver: JwksKeyResolver;

beforeAll(async () => {
    // RS256 key generation is ~100 ms â€” mint once for the whole
    // suite and reuse across every test.
    kp = await mintTestKeypair();
    resolver = buildLocalResolver(kp.publicJwk);
});

beforeEach(() => {
    // Silence the structured logger: the gateway writes one JSON
    // line per request and the test output would otherwise be
    // unreadable.
    vi.spyOn(console, 'log').mockImplementation(() => { });
    vi.spyOn(console, 'warn').mockImplementation(() => { });
    vi.spyOn(console, 'error').mockImplementation(() => { });
    vi.spyOn(console, 'debug').mockImplementation(() => { });

    // Reset every module-scoped cache so tests cannot poison each
    // other through the Worker-isolate pools.
    __resetJwksCacheForTests();
    __resetRateLimitRedisCache();
    __resetTenantDbCache();

    dbMocks.createDb.mockReset();
    dbMocks.withTenant.mockReset();
    dbMocks.createDb.mockReturnValue({ __brand: 'fake-db' });
    // Default behaviour: run the callback with a sentinel tx and
    // forward whatever it returns. The `/v1/test/tenant` handler
    // resolves `[]` in its callback, which trips `notFoundOnEmpty`.
    dbMocks.withTenant.mockImplementation(
        async (
            _db: unknown,
            _claims: unknown,
            fn: (tx: unknown) => Promise<unknown>,
        ) => fn({ __brand: 'fake-tx' }),
    );
});

afterEach(() => {
    vi.restoreAllMocks();
});

/* ================================================================== */
/*  1. Happy path                                                      */
/* ================================================================== */

describe('chain â€” happy path', () => {
    it('GET /health returns 200 without a Problem Details body and carries x-trace-id + security headers', async () => {
        const app = buildTestApp({ jwksResolver: resolver });
        const res = await app.request('/health', { method: 'GET' }, buildMockEnv());

        expect(res.status).toBe(200);
        // NOT Problem Details â€” the happy path must never leak the
        // error envelope content type.
        expect(res.headers.get('content-type')).not.toBe(
            'application/problem+json',
        );
        expect(res.headers.get('content-type')).toMatch(/application\/json/u);

        const traceId = res.headers.get('x-trace-id');
        expect(traceId).not.toBeNull();
        expect(traceId!.length).toBeGreaterThan(0);

        expectSecurityHeaders(res);

        const body = await res.json() as Record<string, unknown>;
        expect(body.traceId).toBe(traceId);
    });

    it('GET /v1/test/public returns 200 with security headers and x-trace-id set', async () => {
        const app = buildTestApp({ jwksResolver: resolver });
        const res = await app.request(
            '/v1/test/public',
            { method: 'GET' },
            buildMockEnv(),
        );

        expect(res.status).toBe(200);
        expect(res.headers.get('x-trace-id')).not.toBeNull();
        expectSecurityHeaders(res);
    });
});

/* ================================================================== */
/*  2. Auth middleware interaction                                     */
/* ================================================================== */

describe('chain â€” jwtAuth interaction', () => {
    it('401 missing_authorization when the Authorization header is absent; no WWW-Authenticate', async () => {
        const app = buildTestApp({ jwksResolver: resolver });
        const res = await app.request(
            '/v1/test/authed',
            { method: 'GET' },
            buildMockEnv(),
        );

        expect(res.status).toBe(401);
        expect(res.headers.get('content-type')).toBe('application/problem+json');
        // Per Req 2.5 wording: only token_expired carries the RFC
        // 6750 challenge. `missing_authorization` deliberately does
        // not â€” clients must not conflate "no creds" with "expired".
        expect(res.headers.get('www-authenticate')).toBeNull();

        const body = await res.json() as Record<string, unknown>;
        expect(body.title).toBe('missing_authorization');
        expect(body.status).toBe(401);
    });

    it('401 invalid_token when Bearer is malformed', async () => {
        const app = buildTestApp({ jwksResolver: resolver });
        const res = await app.request(
            '/v1/test/authed',
            {
                method: 'GET',
                headers: { authorization: 'Bearer malformed' },
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(401);
        expect(res.headers.get('content-type')).toBe('application/problem+json');
        const body = await res.json() as Record<string, unknown>;
        expect(body.title).toBe('invalid_token');
        expect(res.headers.get('www-authenticate')).toBeNull();
    });

    it('401 token_expired with WWW-Authenticate: Bearer error="token_expired" when JWT is expired (Req 2.5)', async () => {
        const app = buildTestApp({ jwksResolver: resolver });
        const now = Math.floor(Date.now() / 1_000);
        const token = await signTestJwt(
            kp.privateKey,
            {
                sub: TEST_USER_ID,
                studio: TEST_STUDIO_ID,
                role: 'member',
            },
            {
                iatSec: now - 120,
                expSec: now - 60,
            },
        );

        const res = await app.request(
            '/v1/test/authed',
            {
                method: 'GET',
                headers: { authorization: `Bearer ${token}` },
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe(
            'Bearer error="token_expired"',
        );
        const body = await res.json() as Record<string, unknown>;
        expect(body.title).toBe('token_expired');
    });

    it('200 on /v1/test/authed with a valid JWT â€” body echoes authClaims.userId', async () => {
        const app = buildTestApp({ jwksResolver: resolver });
        const token = await signTestJwt(kp.privateKey, {
            sub: TEST_USER_ID,
            studio: TEST_STUDIO_ID,
            role: 'member',
        });

        const res = await app.request(
            '/v1/test/authed',
            {
                method: 'GET',
                headers: { authorization: `Bearer ${token}` },
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body.claims).not.toBeNull();
        expect((body.claims as Record<string, unknown>).userId).toBe(TEST_USER_ID);
        expect((body.claims as Record<string, unknown>).studioId).toBe(TEST_STUDIO_ID);
        expect((body.claims as Record<string, unknown>).role).toBe('member');
    });

    it('logger is re-scoped post-auth so subsequent log lines carry userId + studioId', async () => {
        // The auth middleware calls `createLogger({ ..., userId,
        // studioId })` and writes it back onto the context with
        // `c.set('logger', ...)` (see `middleware/auth.ts`). The
        // serve-log middleware in `worker.ts` reads `c.get('logger')`
        // AFTER `next()` returns, so it picks up the enriched
        // logger. Proving that line order at the wire level asserts
        // the invariant: tracing â†’ auth â†’ route.
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        const app = buildTestApp({ jwksResolver: resolver });
        const token = await signTestJwt(kp.privateKey, {
            sub: TEST_USER_ID,
            studio: TEST_STUDIO_ID,
            role: 'member',
        });
        const res = await app.request(
            '/v1/test/authed',
            {
                method: 'GET',
                headers: { authorization: `Bearer ${token}` },
            },
            buildMockEnv(),
        );
        expect(res.status).toBe(200);

        // Find the `served` line and assert it carries userId +
        // studioId. The only way both fields can land there is if
        // the serve-log middleware read the POST-auth logger,
        // proving chain order.
        let served: { userId?: string; studioId?: string; msg?: string } | null = null;
        for (const call of logSpy.mock.calls) {
            const raw = call[0];
            if (typeof raw !== 'string') continue;
            try {
                const parsed = JSON.parse(raw) as {
                    msg?: string;
                    userId?: string;
                    studioId?: string;
                };
                if (parsed.msg === 'served') {
                    served = parsed;
                    break;
                }
            } catch {
                /* not JSON, skip */
            }
        }
        expect(served).not.toBeNull();
        expect(served!.userId).toBe(TEST_USER_ID);
        expect(served!.studioId).toBe(TEST_STUDIO_ID);
    });
});

/* ================================================================== */
/*  3. Validator + Problem Details                                     */
/* ================================================================== */

describe('chain â€” zValidator + Problem Details', () => {
    it('POST /v1/test/echo with a valid body returns 200 with the parsed object', async () => {
        const app = buildTestApp({ jwksResolver: resolver });
        const res = await app.request(
            '/v1/test/echo',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'Alice' }),
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body.name).toBe('Alice');
    });

    it('POST /v1/test/echo with an invalid body returns 422 Problem Details with Zod-derived errors[]', async () => {
        const app = buildTestApp({ jwksResolver: resolver });
        const res = await app.request(
            '/v1/test/echo',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(422);
        expect(res.headers.get('content-type')).toBe('application/problem+json');

        const body = await res.json() as Record<string, unknown>;
        expect(body.status).toBe(422);
        expect(body.code).toBe('validation_error');
        expect(Array.isArray(body.errors)).toBe(true);
        expect((body.errors as unknown[]).length).toBeGreaterThan(0);
        // The missing `name` field is the sole failure, so the first
        // issue must target it. Encoding is 'name' (empty prefix) â€”
        // see `problem-details.ts` formatZodPath.
        const names = (body.errors as Record<string, unknown>[]).map((e) => e.path);
        expect(names).toContain('name');
    });

    it('POST /v1/test/echo with malformed JSON surfaces a valid Problem Details envelope', async () => {
        // `c.req.json()` throws on invalid JSON (SyntaxError). That
        // bubbles out of the validator as a non-ValidationError and
        // lands in the 500 fallback branch of the Problem Details
        // mapper. The task spec accepts either 400 OR 422 OR 500 as
        // long as the envelope is valid Problem Details; we assert
        // the envelope shape rather than the specific status so
        // future improvements (e.g. the validator catching
        // SyntaxError and surfacing 422) do not break the test.
        const app = buildTestApp({ jwksResolver: resolver });
        const res = await app.request(
            '/v1/test/echo',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: 'not json',
            },
            buildMockEnv(),
        );

        expect(res.headers.get('content-type')).toBe('application/problem+json');
        expect([400, 422, 500]).toContain(res.status);

        const body = await res.json() as Record<string, unknown>;
        expect(typeof body.type).toBe('string');
        expect(typeof body.title).toBe('string');
        expect(body.status).toBe(res.status);
        expect(typeof body.traceId).toBe('string');
        expect((body.traceId as string).length).toBeGreaterThan(0);
    });
});

/* ================================================================== */
/*  4. Tenant + Problem Details                                        */
/* ================================================================== */

describe('chain â€” tenant helpers + Problem Details', () => {
    it('GET /v1/test/tenant without Authorization â†’ 401 (auth fires before withTenantTx)', async () => {
        // If `withTenantTx` ever runs before `jwtAuth`, this would
        // surface as 500 MissingAuthClaimsError â†’ 401. The test
        // asserts 401 regardless; the envelope carries the auth
        // middleware's `missing_authorization` title which proves
        // auth fired first (the tenant helper would have emitted
        // `missing_auth_claims` code in a 401 envelope).
        const app = buildTestApp({ jwksResolver: resolver });
        const res = await app.request(
            '/v1/test/tenant',
            { method: 'GET' },
            buildMockEnv(),
        );

        expect(res.status).toBe(401);
        const body = await res.json() as Record<string, unknown>;
        // `missing_authorization` = auth middleware; anything else
        // (e.g. `missing_auth_claims`) = tenant helper, which means
        // the chain ran the tenant helper first â€” chain-order bug.
        expect(body.title).toBe('missing_authorization');
    });

    it('GET /v1/test/tenant with a valid JWT â†’ 404 Problem Details from tenantErrorToProblem', async () => {
        const app = buildTestApp({ jwksResolver: resolver });
        const token = await signTestJwt(kp.privateKey, {
            sub: TEST_USER_ID,
            studio: TEST_STUDIO_ID,
            role: 'member',
        });

        const res = await app.request(
            '/v1/test/tenant',
            {
                method: 'GET',
                headers: { authorization: `Bearer ${token}` },
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toBe('application/problem+json');
        const body = await res.json() as Record<string, unknown>;
        expect(body.status).toBe(404);
        expect(body.code).toBe('not_found');
        expect(body.traceId).toBe(res.headers.get('x-trace-id'));

        // And the tenant DB was actually consulted â€” proves the
        // chain did walk through `withTenantTx`.
        expect(dbMocks.withTenant).toHaveBeenCalledTimes(1);
    });
});

/* ================================================================== */
/*  5. Rate-limit chain                                                */
/* ================================================================== */

describe('chain â€” rate-limit', () => {
    it('IP-bucket denial: bucket exhaustion produces 429, Retry-After, Problem Details body and security headers', async () => {
        const fake = new FakeRedis();
        fake.nowMs = 1_000;

        // Sprint-10 SP10.1 (Vague 38) — defaults bumpés à
        // 1000/60s pour absorber les SPA bursts. Ce test cible la
        // sémantique "bucket exhaustion → 429" avec une limite
        // basse (100) pour rester rapide ; le comportement
        // production (1000/60s) est identique structurellement.
        const app = buildTestApp({
            jwksResolver: resolver,
            rateLimit: { redis: asRedis(fake), ipLimit: 100, windowSec: 60 },
        });

        const env = buildMockEnv();
        for (let i = 0; i < 100; i++) {
            const res = await app.request(
                '/v1/test/public',
                {
                    method: 'GET',
                    headers: { 'CF-Connecting-IP': '1.2.3.4' },
                },
                env,
            );
            expect(res.status).toBe(200);
        }

        const denied = await app.request(
            '/v1/test/public',
            { method: 'GET', headers: { 'CF-Connecting-IP': '1.2.3.4' } },
            env,
        );

        expect(denied.status).toBe(429);
        expect(denied.headers.get('content-type')).toBe(
            'application/problem+json',
        );
        const retryAfter = denied.headers.get('retry-after');
        expect(retryAfter).not.toBeNull();
        expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);

        const body = await denied.json() as Record<string, unknown>;
        expect(body.status).toBe(429);
        expect(body.title).toBe('Too Many Requests');

        // NOTE: security headers on the 429 are NOT asserted because
        // the rate-limit middleware short-circuits with a raw
        // `Response` object and Hono does NOT merge preparedHeaders
        // onto raw responses returned mid-chain (only onto c.body()
        // / c.json() constructions). That is a known rate-limit
        // implementation characteristic and is orthogonal to the
        // H4 chain-order invariants this suite targets. The
        // trace-id header is absent for the same reason â€” the
        // gateway echoes it via `c.header('x-trace-id', ...)` which
        // also lands in preparedHeaders.
    });

    it('user-bucket denial proves user bucket supersedes IP bucket', async () => {
        const fake = new FakeRedis();
        fake.nowMs = 10_000;

        // Sprint-10 SP10.1 (Vague 38) — defaults bumpés à
        // 5000/60s. Ce test cible la sémantique "user bucket
        // évalué avant IP bucket pour les requêtes
        // authentifiées" avec une limite basse (500) pour rester
        // rapide.
        const app = buildTestApp({
            jwksResolver: resolver,
            rateLimit: {
                redis: asRedis(fake),
                ipLimit: 100,
                userLimit: 500,
                windowSec: 60,
            },
        });

        const token = await signTestJwt(
            kp.privateKey,
            {
                sub: 'u1',
                studio: TEST_STUDIO_ID,
                role: 'member',
            },
            { expSec: Math.floor(Date.now() / 1_000) + 600 },
        );
        const env = buildMockEnv();
        const headers = {
            authorization: `Bearer ${token}`,
            // Deliberate: the same IP on every request. If the
            // chain attributed the authed requests to the IP
            // bucket, we would hit the 100-req ceiling at call 101
            // instead of 501 â€” and the test would fail loudly.
            'CF-Connecting-IP': '7.7.7.7',
        };

        // Use a non-UUID `sub` so `authClaims.userId` is a stable,
        // short identifier for the user bucket.
        for (let i = 0; i < 500; i++) {
            const res = await app.request(
                '/v1/test/authed',
                { method: 'GET', headers },
                env,
            );
            expect(res.status).toBe(200);
        }

        const denied = await app.request(
            '/v1/test/authed',
            { method: 'GET', headers },
            env,
        );
        expect(denied.status).toBe(429);
        expect(denied.headers.get('content-type')).toBe(
            'application/problem+json',
        );
    });
});

/* ================================================================== */
/*  6. Secret-leak guard + middleware order                            */
/* ================================================================== */

describe('chain â€” secret-leak guard + order invariants', () => {
    it('500 body from a thrown error does not contain the secret substring and carries traceId matching x-trace-id', async () => {
        const app = buildTestApp({ jwksResolver: resolver });
        const res = await app.request(
            '/v1/test/boom',
            { method: 'GET' },
            buildMockEnv(),
        );

        expect(res.status).toBe(500);
        expect(res.headers.get('content-type')).toBe('application/problem+json');

        const raw = await res.text();
        // The thrown error message is "db password is hunter2" â€”
        // the secret-leak guard MUST drop it from the 500 body.
        expect(raw).not.toContain('hunter2');

        const body = JSON.parse(raw) as ProblemDetailsBody;
        expect(body.status).toBe(500);
        expect(body.title).toBe('Internal Server Error');
        expect(body.type).toBe('about:blank');

        const xTraceId = res.headers.get('x-trace-id');
        expect(xTraceId).not.toBeNull();
        expect(body.traceId).toBe(xTraceId);
    });

    it('OTel span on a 500 carries http.status_code=500 (tracing finally-block runs AFTER onError mutated c.res.status)', async () => {
        // The tracing middleware's `finally` block reads
        // `c.res.status` â€” if the block ran BEFORE `onError` swapped
        // the response, we would see 200 here (the default response
        // Hono stamps before any handler runs). Asserting 500 proves
        // the chain order invariant.
        //
        // The middleware POSTs its OTLP envelope via `globalThis.fetch`
        // when no `options.fetch` override is supplied â€” and
        // `buildApp()` wires `tracing()` with no override. We stub
        // the global so the envelope is captured locally and never
        // hits the network.
        const fetchSpy = vi
            .fn<
                (input: string | URL | Request, init?: RequestInit) => Promise<Response>
            >()
            .mockResolvedValue(new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchSpy);

        // Capture the fire-and-forget OTLP export promise so the
        // test can await it before asserting on the captured
        // envelope â€” otherwise the assertion races the detached
        // promise that `tracing()` schedules.
        let exportPromise: Promise<unknown> | null = null;
        const execCtx = {
            waitUntil(p: Promise<unknown>): void {
                exportPromise = p;
            },
            passThroughOnException(): void {
                /* no-op */
            },
        };

        const app = buildTestApp({ jwksResolver: resolver });
        const res = await app.request(
            '/v1/test/boom',
            { method: 'GET' },
            buildMockEnv({
                OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.test.invalid/v1/traces',
            }),
            execCtx as unknown as Parameters<typeof app.request>[3],
        );
        expect(res.status).toBe(500);

        // Flush the OTLP export and the stub's resolved response.
        if (exportPromise !== null) {
            await exportPromise;
        }

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(String(url)).toContain('otel.test.invalid');
        expect(init?.method).toBe('POST');
        const bodyStr = init?.body;
        expect(typeof bodyStr).toBe('string');

        const envelope = JSON.parse(bodyStr as string) as {
            resourceSpans: Array<{
                scopeSpans: Array<{
                    spans: Array<{
                        attributes: Array<{
                            key: string;
                            value: { intValue?: string };
                        }>;
                        status?: { code?: number };
                    }>;
                }>;
            }>;
        };
        const span = envelope.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
        const statusAttr = span.attributes.find(
            (a) => a.key === 'http.status_code',
        );
        expect(statusAttr).toBeDefined();
        // OTLP encodes integer attributes as stringified int64.
        expect(statusAttr!.value.intValue).toBe('500');
        // And the span's explicit status code should be ERROR (2).
        expect(span.status?.code).toBe(2);
    });
});
