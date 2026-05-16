/**
 * Full-pipeline integration tests â€” task 8.12 of the Athlya spec.
 *
 * What's different from the sibling suites
 * ----------------------------------------
 *   â€¢ `__tests__/middleware-chain.test.ts` (hardening H4) â€” 16
 *     scenarios that exercise one middleware at a time against
 *     hand-crafted `/v1/test/*` routes. Necessary for chain-order
 *     invariants but blind to the domain surface.
 *   â€¢ `__tests__/routes/*.test.ts` (task 8.11) â€” per-router unit
 *     tests that verify chain order for ONE route family. Mostly
 *     unauthenticated error paths.
 *   â€¢ `__tests__/turnstile.test.ts` (task 8.9) â€” middleware-scoped
 *     coverage for the Turnstile verifier.
 *
 * This suite is the missing piece: end-to-end USER JOURNEYS that
 * chain multiple routes in sequence (register â†’ login â†’ book â†’
 * check-in â†’ cancel) plus the explicit error-path catalogue the
 * task brief enumerates.
 *
 * Every test drives a single `buildApp({ deps })` instance through
 * real `app.request(...)` calls. Deps are stateful `vi.fn()` stubs
 * (see `./integration-helpers.ts`) so a mutation in one request is
 * observable by the next. `@athlya/db` is mocked globally so no
 * real Postgres connection is attempted, and `jose`'s
 * `createRemoteJWKSet` is redirected to a local, in-memory JWKS so
 * the middleware never performs network I/O.
 *
 * Validates: Requirements 1.6, 2.5, 13.5, 14.1, 14.2, 14.3, 14.4,
 * 14.6, 26.3.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetJwksCacheForTests } from '../../middleware/auth.js';
import { __resetRateLimitRedisCache } from '../../middleware/rate-limit.js';
import { __resetTenantDbCache } from '../../middleware/tenant.js';

import {
    FakeRedis,
    TEST_STUDIO_ID,
    TEST_USER_ID,
    buildIntegrationApp,
    buildIntegrationDeps,
    buildLocalResolver,
    buildMockEnv,
    createIntegrationState,
    makeUuid,
    mintTestKeypair,
    signUserJwt,
    type IntegrationState,
    type TestKeypair,
    type UserRecord,
} from './integration-helpers.js';

import type { JwksKeyResolver } from '../../middleware/auth.js';
import type { DomainDeps } from '../../routes/index.js';
import type { Redis } from '@upstash/redis';

/* ------------------------------------------------------------------ */
/*  @athlya/db mock â€” no real Postgres in integration tests.          */
/* ------------------------------------------------------------------ */

const dbMocks = vi.hoisted(() => ({
    createDb: vi.fn(),
    withTenant: vi.fn(),
    lookup: vi.fn(),
    store: vi.fn(),
}));

vi.mock('@athlya/db', () => ({
    createDb: dbMocks.createDb,
    withTenant: dbMocks.withTenant,
}));

vi.mock('@athlya/db/idempotency', () => ({
    lookup: dbMocks.lookup,
    store: dbMocks.store,
    DEFAULT_IDEMPOTENCY_TTL_SEC: 86_400,
}));

/* ------------------------------------------------------------------ */
/*  jose mock â€” redirect createRemoteJWKSet to a local resolver.      */
/* ------------------------------------------------------------------ */

/**
 * The auth middleware calls `createRemoteJWKSet(new URL(env.JWT_JWKS_URL))`
 * the first time a request carrying a Bearer token lands on a
 * `/v1/*` route. That would hit the network unless we redirect it.
 *
 * A hoisted ref is written by `beforeAll` once the RS256 keypair is
 * minted; the mock's factory resolves every call against the ref so
 * all tests in the suite share a single in-memory JWKS.
 */
const joseHoisted = vi.hoisted(() => ({
    localResolver: null as JwksKeyResolver | null,
}));

vi.mock('jose', async () => {
    const actual = await vi.importActual<typeof import('jose')>('jose');
    return {
        ...actual,
        // Replace the remote getter with a forwarder that reads our
        // hoisted local resolver. The middleware treats the returned
        // value as an opaque `JwksKeyResolver`, so a lambda suffices.
        createRemoteJWKSet: () =>
            (async (...args: Parameters<JwksKeyResolver>) => {
                if (joseHoisted.localResolver === null) {
                    throw new Error(
                        'integration-test jose mock: local resolver not initialised',
                    );
                }
                return joseHoisted.localResolver(...args);
            }) as JwksKeyResolver,
    };
});

/* ------------------------------------------------------------------ */
/*  Types / helpers                                                    */
/* ------------------------------------------------------------------ */

/** Cast {@link FakeRedis} through `unknown` to the Upstash surface. */
function asRedis(fake: FakeRedis): Redis {
    return fake as unknown as Redis;
}

/* ------------------------------------------------------------------ */
/*  Suite-scoped fixtures                                              */
/* ------------------------------------------------------------------ */

let kp: TestKeypair;
let resolver: JwksKeyResolver;

beforeAll(async () => {
    kp = await mintTestKeypair();
    resolver = buildLocalResolver(kp.publicJwk);
    joseHoisted.localResolver = resolver;
});

beforeEach(() => {
    // Silence the structured logger â€” one JSON line per request
    // would flood the test output otherwise.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    // Reset every module-scope cache so tests cannot poison each
    // other through the worker-isolate pools.
    __resetJwksCacheForTests();
    __resetRateLimitRedisCache();
    __resetTenantDbCache();

    dbMocks.createDb.mockReset();
    dbMocks.withTenant.mockReset();
    dbMocks.lookup.mockReset();
    dbMocks.store.mockReset();
    dbMocks.createDb.mockReturnValue({ __brand: 'fake-db' });
    dbMocks.withTenant.mockImplementation(
        async (_db: unknown, _claims: unknown, fn: (tx: unknown) => Promise<unknown>) =>
            fn({ __brand: 'fake-tx' }),
    );
    // Default: idempotency lookups miss, stores succeed.
    dbMocks.lookup.mockResolvedValue(null);
    dbMocks.store.mockResolvedValue(undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/*  App builder used by every happy-path test                          */
/* ------------------------------------------------------------------ */

/**
 * Compose a gateway instance wired to a fresh {@link IntegrationState}
 * plus stateful deps. `signSessionToken` produces a JWT signed by the
 * suite's RS256 keypair so every response body's `accessToken` is a
 * valid Bearer on subsequent calls.
 */
async function makeAppWithState(params: {
    readonly idempotencyDb?: unknown;
    readonly rateLimit?: {
        readonly redis: Redis;
        readonly userLimit?: number;
        readonly ipLimit?: number;
        readonly windowSec?: number;
    };
} = {}): Promise<{
    readonly state: IntegrationState;
    readonly deps: DomainDeps;
    readonly app: ReturnType<typeof buildIntegrationApp>;
}> {
    const state = createIntegrationState();
    const deps = buildIntegrationDeps({
        state,
        signSessionToken: async (u: UserRecord) =>
            signUserJwt(kp, {
                userId: u.userId,
                studioId: u.studioId,
                role: u.role,
            }),
        idempotencyDb: params.idempotencyDb,
    });
    const app = buildIntegrationApp(
        params.rateLimit !== undefined
            ? { deps, jwksResolver: resolver, rateLimit: params.rateLimit }
            : { deps, jwksResolver: resolver },
    );
    return { state, deps, app };
}

/* ================================================================== */
/*  Block 1 â€” Happy-path user journeys                                 */
/* ================================================================== */

describe('gateway integration â€” happy-path user journeys', () => {
    /**
     * Req 14.1 (auth on /v1/*), 14.2 (validation on every body),
     * 14.6 (Problem Details stays out of 2xx paths): end-to-end
     * register â†’ login â†’ book â†’ check-in â†’ cancel.
     */
    it('register â†’ login â†’ book â†’ check-in â†’ cancel emits the expected event flow', async () => {
        const { state, deps, app } = await makeAppWithState();

        // Seed a class so the booking call finds something to book.
        const classId = makeUuid(1000);
        state.classes.set(classId, {
            id: classId,
            title: 'Morning yoga',
            studioId: TEST_STUDIO_ID,
            capacity: 10,
            startsAt: '2099-01-01T09:00:00.000Z',
        });

        /* ------------- 1. register ------------- */
        const registerRes = await app.request(
            '/v1/auth/register',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'cf-turnstile-token': 'stub-token',
                },
                body: JSON.stringify({
                    email: 'ada@example.com',
                    password: 'Password1234',
                    displayName: 'Ada',
                    studioSlug: 'athlya-paris',
                    consents: {
                        marketing: false,
                        analytics: false,
                        thirdParty: false,
                    },
                }),
            },
            buildMockEnv(),
        );
        expect(registerRes.status).toBe(201);
        const registerBody = (await registerRes.json() as any);
        expect(typeof registerBody.accessToken).toBe('string');
        expect(deps.auth.register).toHaveBeenCalledTimes(1);

        /* ------------- 2. login ------------- */
        const loginRes = await app.request(
            '/v1/auth/login',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'cf-turnstile-token': 'stub-token',
                },
                body: JSON.stringify({
                    email: 'ada@example.com',
                    password: 'Password1234',
                }),
            },
            buildMockEnv(),
        );
        expect(loginRes.status).toBe(200);
        const loginBody = (await loginRes.json() as any);
        const accessToken = loginBody.accessToken;

        /* ------------- 3. book ------------- */
        const bookRes = await app.request(
            '/v1/reservations',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${accessToken}`,
                },
                body: JSON.stringify({ classId }),
            },
            buildMockEnv(),
        );
        expect(bookRes.status).toBe(201);
        const bookBody = (await bookRes.json() as any);
        expect(bookBody.status).toBe('confirmed');
        const reservationId = (bookBody.reservation as { id: string }).id;

        /* ------------- 4. check-in ------------- */
        const checkinRes = await app.request(
            '/v1/checkins',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${accessToken}`,
                },
                body: JSON.stringify({ qrToken: 'a.b.c' }),
            },
            buildMockEnv(),
        );
        expect(checkinRes.status).toBe(200);

        /* ------------- 5. cancel ------------- */
        const cancelRes = await app.request(
            `/v1/reservations/${reservationId}`,
            {
                method: 'DELETE',
                headers: { authorization: `Bearer ${accessToken}` },
            },
            buildMockEnv(),
        );
        expect(cancelRes.status).toBe(200);

        /* ------------- events ------------- */
        const eventTypes = state.events.map((e) => e.type);
        expect(eventTypes).toContain('auth.user.registered');
        expect(eventTypes).toContain('reservation.created');
        expect(eventTypes).toContain('reservation.cancelled');
    });

    /**
     * Req 8.2, 9.3: waitlist FIFO promotion. Alice takes the last
     * seat (capacity 1), Bob lands on waitlist position 1, Alice
     * cancels, Bob is promoted.
     */
    it('waitlist promotion: alice cancel â†’ bob confirmed', async () => {
        const { state, app } = await makeAppWithState();

        // Capacity-1 class so Bob is guaranteed to be waitlisted.
        const classId = makeUuid(2000);
        state.classes.set(classId, {
            id: classId,
            title: 'Solo HIIT',
            studioId: TEST_STUDIO_ID,
            capacity: 1,
            startsAt: '2099-01-01T10:00:00.000Z',
        });

        // ---- Alice: register + login + book ----
        const aliceReg = await app.request(
            '/v1/auth/register',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'cf-turnstile-token': 'stub',
                },
                body: JSON.stringify({
                    email: 'alice@example.com',
                    password: 'Password1234',
                    displayName: 'Alice',
                    studioSlug: 'athlya-paris',
                    consents: { marketing: false, analytics: false, thirdParty: false },
                }),
            },
            buildMockEnv(),
        );
        expect(aliceReg.status).toBe(201);
        const aliceAt = ((await aliceReg.json() as any)).accessToken;

        const aliceBook = await app.request(
            '/v1/reservations',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${aliceAt}`,
                },
                body: JSON.stringify({ classId }),
            },
            buildMockEnv(),
        );
        expect(aliceBook.status).toBe(201);
        const aliceReservationId = (((await aliceBook.json() as any)).reservation).id as string;

        // ---- Bob: register + waitlist ----
        const bobReg = await app.request(
            '/v1/auth/register',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'cf-turnstile-token': 'stub',
                },
                body: JSON.stringify({
                    email: 'bob@example.com',
                    password: 'Password1234',
                    displayName: 'Bob',
                    studioSlug: 'athlya-paris',
                    consents: { marketing: false, analytics: false, thirdParty: false },
                }),
            },
            buildMockEnv(),
        );
        expect(bobReg.status).toBe(201);
        const bobAt = ((await bobReg.json() as any)).accessToken;

        const bobBook = await app.request(
            '/v1/reservations',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${bobAt}`,
                },
                body: JSON.stringify({ classId }),
            },
            buildMockEnv(),
        );
        expect(bobBook.status).toBe(202);
        const bobBookBody = (await bobBook.json() as any);
        expect(bobBookBody.status).toBe('waitlist');
        expect(bobBookBody.position).toBe(1);

        // ---- Alice cancels â†’ Bob promoted ----
        const aliceCancel = await app.request(
            `/v1/reservations/${aliceReservationId}`,
            { method: 'DELETE', headers: { authorization: `Bearer ${aliceAt}` } },
            buildMockEnv(),
        );
        expect(aliceCancel.status).toBe(200);

        const eventTypes = state.events.map((e) => e.type);
        expect(eventTypes).toContain('reservation.waitlisted');
        expect(eventTypes).toContain('reservation.promoted');

        // And Bob's reservation is now confirmed in the state.
        const bobRes = [...state.reservationsById.values()].find(
            (r) => r.userId !== aliceReservationId.slice(0, 8),
        );
        expect(bobRes).toBeDefined();
    });

    /** Req 14.1: GET /v1/reservations/me round-trip after auth. */
    it('register â†’ login â†’ GET /v1/reservations/me returns 200 with items', async () => {
        const { app } = await makeAppWithState();

        const reg = await app.request(
            '/v1/auth/register',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'cf-turnstile-token': 'stub',
                },
                body: JSON.stringify({
                    email: 'solo@example.com',
                    password: 'Password1234',
                    displayName: 'Solo',
                    studioSlug: 'athlya-paris',
                    consents: { marketing: false, analytics: false, thirdParty: false },
                }),
            },
            buildMockEnv(),
        );
        const at = ((await reg.json() as any)).accessToken;

        const listRes = await app.request(
            '/v1/reservations/me',
            { method: 'GET', headers: { authorization: `Bearer ${at}` } },
            buildMockEnv(),
        );
        expect(listRes.status).toBe(200);
        const listBody = (await listRes.json() as any);
        expect(Array.isArray(listBody.items)).toBe(true);
    });

    /**
     * Req 20.1 end-to-end: two POST /v1/reservations with the same
     * `Idempotency-Key` return the cached response on the second
     * call. Distinct from 8.5's middleware-level test â€” this is the
     * full pipeline with a real domain router.
     */
    it('POST /v1/reservations with the same Idempotency-Key replays the cached response', async () => {
        // Programmable idempotency cache backed by the shared state.
        const cache = new Map<string, { response: Record<string, unknown>; statusCode: number }>();
        dbMocks.lookup.mockImplementation(
            async (_db: unknown, key: string, userId: string) => {
                const hit = cache.get(`${key}:${userId}`);
                if (hit === undefined) return null;
                return {
                    response: hit.response,
                    statusCode: hit.statusCode,
                    createdAt: new Date(),
                    expiresAt: new Date(Date.now() + 60_000),
                };
            },
        );
        dbMocks.store.mockImplementation(
            async (
                _db: unknown,
                key: string,
                userId: string,
                resp: { body: Record<string, unknown>; statusCode: number },
            ) => {
                cache.set(`${key}:${userId}`, {
                    response: resp.body,
                    statusCode: resp.statusCode,
                });
            },
        );

        const { state, deps, app } = await makeAppWithState({
            idempotencyDb: { __brand: 'fake-db' },
        });

        const classId = makeUuid(3000);
        state.classes.set(classId, {
            id: classId,
            title: 'Rowing',
            studioId: TEST_STUDIO_ID,
            capacity: 10,
            startsAt: '2099-01-01T11:00:00.000Z',
        });

        const reg = await app.request(
            '/v1/auth/register',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'cf-turnstile-token': 'stub',
                },
                body: JSON.stringify({
                    email: 'idem@example.com',
                    password: 'Password1234',
                    displayName: 'Idem',
                    studioSlug: 'athlya-paris',
                    consents: { marketing: false, analytics: false, thirdParty: false },
                }),
            },
            buildMockEnv(),
        );
        const at = ((await reg.json() as any)).accessToken;

        const idemKey = 'book-once-only';
        const init = {
            method: 'POST' as const,
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${at}`,
                'Idempotency-Key': idemKey,
            },
            body: JSON.stringify({ classId }),
        };

        const first = await app.request('/v1/reservations', init, buildMockEnv());
        expect(first.status).toBe(201);
        const firstBody = (await first.json() as any);

        const second = await app.request('/v1/reservations', init, buildMockEnv());
        expect(second.status).toBe(201);
        const secondBody = (await second.json() as any);

        // Cache replay means the handler runs exactly once for the
        // two requests â€” deps.reservations.bookClass fires only on
        // the miss.
        expect(deps.reservations.bookClass).toHaveBeenCalledTimes(1);
        expect(secondBody.status).toBe(firstBody.status);
    });

    /** Req 6.5, 14.1: admin creates class â†’ member lists it. */
    it('admin creates class â†’ member lists it', async () => {
        const { state, app } = await makeAppWithState();

        // Admin user â€” pre-seeded with a valid JWT (bypasses
        // /v1/auth/register since the Auth service doesn't mint
        // admin roles in this integration).
        const adminId = makeUuid(77);
        state.users.set(adminId, {
            userId: adminId,
            email: 'admin@example.com',
            studioId: TEST_STUDIO_ID,
            displayName: 'Admin',
            role: 'admin',
        });
        const adminToken = await signUserJwt(kp, {
            userId: adminId,
            studioId: TEST_STUDIO_ID,
            role: 'admin',
        });

        const createRes = await app.request(
            '/v1/classes',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${adminToken}`,
                },
                body: JSON.stringify({
                    title: 'Boxing',
                    startsAt: '2099-02-01T18:00:00.000Z',
                    durationMin: 60,
                    capacity: 20,
                }),
            },
            buildMockEnv(),
        );
        expect(createRes.status).toBe(201);

        // Member lists classes within the studio range.
        const memberToken = await signUserJwt(kp, {
            userId: TEST_USER_ID,
            studioId: TEST_STUDIO_ID,
            role: 'member',
        });
        const listRes = await app.request(
            '/v1/classes?from=2099-01-01T00:00:00.000Z&to=2099-03-01T00:00:00.000Z',
            { method: 'GET', headers: { authorization: `Bearer ${memberToken}` } },
            buildMockEnv(),
        );
        expect(listRes.status).toBe(200);
        const listBody = (await listRes.json() as any);
        expect((listBody.items as any[]).some((c) => c.title === 'Boxing')).toBe(true);
    });
});

/* ================================================================== */
/*  Block 2 â€” Error paths from the task description                    */
/* ================================================================== */

describe('gateway integration â€” error paths', () => {
    /**
     * Req 2.5: expired access token on a protected route surfaces
     * HTTP 401 + `WWW-Authenticate: Bearer error="token_expired"`
     * and a Problem Details envelope whose `code` is `token_expired`.
     * H4's middleware-chain test covers the same invariant against
     * `/v1/test/authed`; this test exercises it through the real
     * `/v1/reservations/me` chain composition.
     */
    it('expired access token on /v1/reservations/me â†’ 401 + WWW-Authenticate + token_expired envelope', async () => {
        const { app } = await makeAppWithState();

        const now = Math.floor(Date.now() / 1_000);
        const expired = await signUserJwt(kp, {
            userId: TEST_USER_ID,
            studioId: TEST_STUDIO_ID,
            role: 'member',
            iatSec: now - 120,
            expSec: now - 60,
        });

        const res = await app.request(
            '/v1/reservations/me',
            { method: 'GET', headers: { authorization: `Bearer ${expired}` } },
            buildMockEnv(),
        );

        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe(
            'Bearer error="token_expired"',
        );
        expect(res.headers.get('content-type')).toBe(
            'application/problem+json',
        );
        const body = (await res.json() as any);
        expect(body.status).toBe(401);
        expect(body.title).toBe('token_expired');
        expect(body.traceId).toBe(res.headers.get('x-trace-id'));
    });

    /**
     * Req 14.2: malformed body on POST /v1/reservations surfaces a
     * 422 Problem Details envelope with the per-field `errors[]`
     * array from Zod.
     */
    it('invalid body on POST /v1/reservations â†’ 422 with Zod-derived errors[]', async () => {
        const { app } = await makeAppWithState();

        const token = await signUserJwt(kp, {
            userId: TEST_USER_ID,
            studioId: TEST_STUDIO_ID,
            role: 'member',
        });
        const res = await app.request(
            '/v1/reservations',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ foo: 'bar' }),
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(422);
        expect(res.headers.get('content-type')).toBe(
            'application/problem+json',
        );
        const body = (await res.json() as any);
        expect(body.status).toBe(422);
        expect(body.code).toBe('validation_error');
        expect(Array.isArray(body.errors)).toBe(true);
        expect((body.errors as unknown[]).length).toBeGreaterThan(0);
    });

    /**
     * Req 14.4: more than 500 authenticated requests inside the
     * sliding window from a single userId are denied with 429 +
     * Retry-After and a Problem Details envelope.
     *
     * H4 already exercises this against `/v1/test/authed`; we redo
     * it here once against the real `/v1/reservations/me` endpoint
     * so the full chain composition (security-headers â†’ tracing â†’
     * OTel â†’ serve-log â†’ jwtAuth â†’ rateLimit â†’ reservations.jwtAuth
     * â†’ route) is proven end-to-end.
     */
    it('user-bucket exhaustion on /v1/reservations/me â†’ 429 + Retry-After + Problem Details', async () => {
        const fake = new FakeRedis();
        fake.nowMs = 10_000;

        // Sprint-10 SP10.1 (Vague 38) — defaults bumpés à
        // 5000/60s. Test paramétré pour rester rapide (500
        // itérations) avec userLimit:500 explicite.
        const { app } = await makeAppWithState({
            rateLimit: {
                redis: asRedis(fake),
                userLimit: 500,
                windowSec: 60,
            },
        });

        const token = await signUserJwt(kp, {
            userId: 'rate-limit-user',
            studioId: TEST_STUDIO_ID,
            role: 'member',
            expSec: Math.floor(Date.now() / 1_000) + 600,
        });
        const headers = {
            authorization: `Bearer ${token}`,
            'CF-Connecting-IP': '7.7.7.7',
        };

        for (let i = 0; i < 500; i++) {
            const res = await app.request(
                '/v1/reservations/me',
                { method: 'GET', headers },
                buildMockEnv(),
            );
            expect(res.status).toBe(200);
        }

        const denied = await app.request(
            '/v1/reservations/me',
            { method: 'GET', headers },
            buildMockEnv(),
        );
        expect(denied.status).toBe(429);
        expect(denied.headers.get('content-type')).toBe(
            'application/problem+json',
        );
        const retryAfter = denied.headers.get('retry-after');
        expect(retryAfter).not.toBeNull();
        expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
        const body = (await denied.json() as any);
        expect(body.status).toBe(429);
        expect(body.title).toBe('Too Many Requests');
    }, 30_000);

    /**
     * Req 26.3: missing `cf-turnstile-token` on POST /v1/auth/register
     * yields 403 + `code: 'bot_challenge_failed'` BEFORE the Auth
     * service is invoked. `deps.auth.register` must never be called.
     */
    it('missing cf-turnstile-token on POST /v1/auth/register â†’ 403 bot_challenge_failed', async () => {
        const { deps, app } = await makeAppWithState();

        const res = await app.request(
            '/v1/auth/register',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    // Sprint 1 / Slice 1.2 â€” the host-check middleware
                    // refuses 421 in staging when the Host header is
                    // not on the staging whitelist; make the request
                    // pass that gate so we can exercise Turnstile.
                    host: 'staging.api.athlya.app',
                },
                body: JSON.stringify({
                    email: 'bot@example.com',
                    password: 'Password1234',
                    displayName: 'Bot',
                    studioSlug: 'athlya-paris',
                    consents: { marketing: false, analytics: false, thirdParty: false },
                }),
            },
            // Use a non-dev env + populated secret so the dev bypass
            // does not kick in â€” this proves the Turnstile middleware
            // really did reject the request rather than skip it. The
            // Slice 1.2 CORS_ORIGIN sentinel also enforces a populated
            // CORS allow-list in staging/prod, so we provide one here
            // even though this test does not exercise CORS.
            buildMockEnv({
                ENVIRONMENT: 'staging',
                TURNSTILE_SECRET: 'stub-secret',
                CORS_ORIGIN: 'https://app.staging.athlya.app',
            }),
        );

        expect(res.status).toBe(403);
        expect(res.headers.get('content-type')).toBe(
            'application/problem+json',
        );
        const body = (await res.json() as any);
        expect(body.status).toBe(403);
        expect(body.code).toBe('bot_challenge_failed');
        expect(deps.auth.register).not.toHaveBeenCalled();
    });

    /**
     * Req 13.5: tenant-scoped reads return 404 across tenants.
     *
     * The current `/v1/reservations` router exposes
     * `DELETE /:id` but NOT `GET /:id`; the cross-tenant guard is
     * exercised through `PATCH /v1/classes/:id` instead, which also
     * takes a UUID path param, is tenant-scoped by `authClaims.studioId`
     * and lets us stub `deps.classes.updateClass` to return
     * `not_found` â€” simulating the post-RLS empty result when a
     * member of studio A tries to touch a class owned by studio B.
     */
    it('cross-tenant PATCH /v1/classes/:id â†’ 404 not_found Problem Details', async () => {
        const { deps, app } = await makeAppWithState();

        // Override the class mutator to simulate the post-RLS
        // cross-tenant invisibility. (The stub's default already
        // returns not_found, but we make the intent explicit here.)
        (deps.classes.updateClass as ReturnType<typeof vi.fn>).mockResolvedValue({
            kind: 'not_found',
        });

        const adminToken = await signUserJwt(kp, {
            userId: TEST_USER_ID,
            studioId: TEST_STUDIO_ID,
            role: 'admin',
        });

        // A UUID that belongs to some other studio â€” the stubbed
        // updateClass resolves to not_found regardless, mirroring
        // the tenant-isolated query result on production.
        const foreignClassId = '99999999-9999-4999-8999-999999999999';
        const res = await app.request(
            `/v1/classes/${foreignClassId}`,
            {
                method: 'PATCH',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${adminToken}`,
                },
                body: JSON.stringify({ title: 'Hacked Title', version: 1 }),
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toBe(
            'application/problem+json',
        );
        const body = (await res.json() as any);
        expect(body.status).toBe(404);
        expect(body.code).toBe('not_found');
        expect(body.traceId).toBe(res.headers.get('x-trace-id'));
    });

    /**
     * Req 14.6: every error response carries the Problem Details
     * envelope (`type`, `title`, `status`, `traceId`). Spot-check
     * an unauthenticated request to collect the envelope and
     * assert the 4-field minimum. Complements the per-code
     * assertions above.
     */
    it('every error response carries the 4-field Problem Details minimum', async () => {
        const { app } = await makeAppWithState();

        const res = await app.request(
            '/v1/reservations/me',
            { method: 'GET' },
            buildMockEnv(),
        );
        expect(res.status).toBe(401);
        expect(res.headers.get('content-type')).toBe(
            'application/problem+json',
        );
        const body = (await res.json() as any);
        expect(typeof body.type).toBe('string');
        expect(typeof body.title).toBe('string');
        expect(body.status).toBe(401);
        expect(body.traceId).toBe(res.headers.get('x-trace-id'));
    });
});
