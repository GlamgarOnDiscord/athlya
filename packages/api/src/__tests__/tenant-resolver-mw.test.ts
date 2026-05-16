/**
 * Integration tests for the host/path â†’ tenant cross-check pipeline
 * landed in Slice 1.4 (Sprint 1 â€” SP1.5, audit finding S2-007).
 *
 * Exercises the two factories exposed by `middleware/tenant-resolver.ts`
 * end-to-end:
 *
 *   1. {@link tenantResolverMiddleware} â€” unconditionally stamps
 *      `tenantSlug` + `tenantSource` onto the context.
 *   2. {@link tenantClaimGuard} â€” refuses requests where the
 *      slug-resolved studio differs from the JWT `studio` claim.
 *
 * Test app architecture
 * ---------------------
 * `buildApp()` from `worker.ts` mounts a strict host whitelist as
 * step 0 â€” `acme.athlya.app` would be refused with 421 in `dev` (the
 * dev whitelist accepts `localhost(:port)`, `127.0.0.1(:port)` and
 * `*.workers.dev` only). We therefore compose a minimal Hono app
 * here that mirrors the production middleware order on the
 * cross-check surface (resolver â†’ jwtAuth â†’ claimGuard â†’ handler)
 * but skips the host check so the suite can target arbitrary
 * production-shaped hosts. The host check itself is exercised by
 * `security-hardening-1-2.test.ts`; its absence here is on purpose.
 *
 * Scenarios (six cases per the slice spec):
 *
 *   1. Host `acme.athlya.app` + JWT `studio = acme.id` â†’ 200.
 *   2. Host `acme.athlya.app` + JWT `studio = beta.id` â†’ 404
 *      Problem Details (`code: 'tenant_mismatch'`).
 *   3. Path `/s/acme/v1/me` + JWT `studio = acme.id` â†’ 200.
 *   4. Apex `api.athlya.app` (mobile case) â†’ guard skipped â†’ 200.
 *   5. `/v1/auth/login` with deliberate slug mismatch â†’ 200 (the
 *      bypass-prefix list explicitly skips pre-auth routes).
 *   6. DB unavailable (`resolveStudioBySlug` throws) â†’ 200 fail-open
 *      + warn line in the structured logger.
 *
 * The test JWT verifier is wired through `buildLocalResolver` so no
 * network I/O reaches `createRemoteJWKSet`.
 *
 * Validates: Requirements 13.2, 13.5; audit finding S2-007.
 */

import { Hono } from 'hono';
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import { jwtAuth } from '../middleware/auth.js';
import {
    __resetTenantClaimGuardCache,
    tenantClaimGuard,
    tenantResolverMiddleware,
} from '../middleware/tenant-resolver.js';

import {
    TEST_STUDIO_ID,
    TEST_USER_ID,
    buildLocalResolver,
    buildMockEnv,
    mintTestKeypair,
    signTestJwt,
    type TestKeypair,
} from './helpers/test-app.js';

import type { JwksKeyResolver } from '../middleware/auth.js';
import type { StudioSlugResolver } from '../middleware/tenant-resolver.js';
import type { AthlyaBindings, HonoEnv } from '../types.js';
import type { MockInstance } from 'vitest';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const ACME_STUDIO_ID = TEST_STUDIO_ID;
const BETA_STUDIO_ID = '33333333-3333-4333-8333-333333333333';

let kp: TestKeypair;
let resolver: JwksKeyResolver;

beforeAll(async () => {
    kp = await mintTestKeypair();
    resolver = buildLocalResolver(kp.publicJwk);
});

afterAll(() => {
    // Nothing to tear down â€” `kp` and `resolver` go out of scope
    // when the suite module unloads.
});

let warnSpy: MockInstance;

beforeEach(() => {
    // Silence the structured-logger lines but keep spies attached so
    // assertions on warn output stay observable.
    vi.spyOn(console, 'log').mockImplementation(() => { });
    vi.spyOn(console, 'error').mockImplementation(() => { });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
    vi.spyOn(console, 'debug').mockImplementation(() => { });
    __resetTenantClaimGuardCache();
});

afterEach(() => {
    vi.restoreAllMocks();
});

/**
 * Sign a JWT carrying a custom `studio` claim. `sub`/`role` default
 * to the standard test fixtures because the slug guard never reads
 * them.
 */
async function mintJwtForStudio(studioId: string): Promise<string> {
    return signTestJwt(kp.privateKey, {
        sub: TEST_USER_ID,
        studio: studioId,
        role: 'member',
    });
}

/**
 * Build the structured-logger context required by `worker.ts`'s
 * tracing middleware. We replicate just enough of the gateway
 * pipeline to feed `c.get('logger')` so the guard's warn-line
 * assertion in the fail-open scenario can succeed.
 */
function loggerMiddleware() {
    return async (
        c: { set: (k: string, v: unknown) => void },
        next: () => Promise<void>,
    ): Promise<void> => {
        const traceId = '0123456789abcdef0123456789abcdef';
        c.set('traceId', traceId);
        // Minimal logger duck-typed against the guard's contract â€”
        // `warn` is the only level it emits.
        c.set('logger', {
            warn: (msg: string, ctx?: Record<string, unknown>) => {
                console.warn(
                    JSON.stringify({ msg, level: 'warn', traceId, ...ctx }),
                );
            },
            info: () => { },
            error: () => { },
            debug: () => { },
        });
        c.set('startedAt', Date.now());
        await next();
    };
}

/**
 * Build a minimal Hono app that exercises ONLY the cross-check
 * pipeline. Skips `buildApp()` so the host whitelist does not
 * interfere with subdomain-shaped hosts.
 *
 * Pipeline:
 *   tenantResolverMiddleware  (sets tenantSlug + tenantSource)
 *   loggerMiddleware           (sets traceId + logger for guard warn)
 *   /v1/*  â†’ bypass /v1/auth/* â†’ jwtAuth â†’ tenantClaimGuard â†’ handler
 *   /s/*   â†’ tenantClaimGuard runs on slug from path
 */
function buildPipelineApp(
    studioBySlug: StudioSlugResolver,
): Hono<HonoEnv> {
    const app = new Hono<HonoEnv>();

    app.use('*', tenantResolverMiddleware());
    app.use('*', loggerMiddleware());

    const guardWrapper = async (
        c: {
            req: { path: string };
            env: AthlyaBindings;
        },
        next: () => Promise<void>,
    ): Promise<Response | void> => {
        // Cast to the authenticated-context shape jwtAuth/guard
        // expect. Hono's live `Context` satisfies the structural
        // contract at runtime; the cast bridges the duck-typed
        // signature this helper uses for portability.
        type AnyCtx = Parameters<ReturnType<typeof jwtAuth>>[0] &
            Parameters<ReturnType<typeof tenantClaimGuard>>[0];
        const ctx = c as unknown as AnyCtx;

        if (c.req.path.startsWith('/v1/auth/')) {
            await next();
            return;
        }

        // tenantSlug undefined â†’ no slug cross-check needed (apex /
        // dev local), and we also skip the inline jwtAuth challenge
        // here so this test surface mirrors the production wiring
        // (which only triggers the cross-check when a slug actually
        // resolved). Authenticated routes that do not carry a slug
        // are still gated by the per-router `jwtAuth()` mount.
        const slug = ctx.get('tenantSlug');
        if (slug === undefined) {
            await next();
            return;
        }

        const authResult = await jwtAuth({ keyResolver: resolver })(
            ctx,
            async () => { },
        );
        if (authResult instanceof Response) {
            return authResult;
        }

        const guard = tenantClaimGuard({
            resolveStudioBySlug: studioBySlug,
            cacheNamespace: c.env.DB_URL,
        });
        const guardResult = await guard(ctx, next);
        if (guardResult instanceof Response) {
            return guardResult;
        }
        return;
    };

    // Mount the wrapper on both the `/v1/*` surface (production
    // tenant-scoped routes) and the `/s/*` surface (path-source
    // tenant prefix consumed by the Next.js web app's edge
    // middleware). The wrapper runs against the duck-typed
    // {@link c} surface above; `app.use(...)` accepts the lambda
    // because Hono structurally compares it against
    // {@link MiddlewareHandler}. The `as never` casts mask the
    // generic-parameter mismatch that comes from typing the
    // wrapper for portability rather than for Hono specifically.
    app.use('/v1/*', guardWrapper as never);
    app.use('/s/*', guardWrapper as never);

    /** Standard tenant-scoped probe â€” returns the resolved context. */
    app.get('/v1/test/me', (c) => {
        return c.json({
            ok: true,
            tenantSlug: c.get('tenantSlug') ?? null,
            tenantSource: c.get('tenantSource') ?? null,
            studioId: c.get('authClaims')?.studioId ?? null,
        });
    });

    /** Path-source variant â€” same handler under the `/s/<slug>/...` prefix. */
    app.get('/s/acme/v1/test/me', (c) => {
        return c.json({
            ok: true,
            tenantSlug: c.get('tenantSlug') ?? null,
            tenantSource: c.get('tenantSource') ?? null,
            studioId: c.get('authClaims')?.studioId ?? null,
        });
    });

    /** Pre-auth bypass â€” the cross-check must not fire. */
    app.post('/v1/auth/login', (c) => c.json({ ok: true, route: 'login' }));

    return app;
}

/** Mock env with a stable DB_URL so cache namespacing is deterministic. */
function envFor(): AthlyaBindings {
    return buildMockEnv();
}

/* ================================================================== */
/*  Scenarios                                                          */
/* ================================================================== */

describe('tenantResolverMiddleware + tenantClaimGuard â€” Slice 1.4', () => {
    /* ---------------------------------------------------------------- */
    /*  1. Subdomain match                                              */
    /* ---------------------------------------------------------------- */

    it('subdomain host matches JWT claim â†’ 200 with tenantSource=subdomain', async () => {
        const studioBySlug: StudioSlugResolver = vi.fn(async (slug) => {
            if (slug === 'acme') return ACME_STUDIO_ID;
            return null;
        });
        const app = buildPipelineApp(studioBySlug);
        const token = await mintJwtForStudio(ACME_STUDIO_ID);

        const res = await app.request(
            'http://acme.athlya.app/v1/test/me',
            {
                method: 'GET',
                headers: { authorization: `Bearer ${token}` },
            },
            envFor(),
        );

        expect(res.status).toBe(200);
        const body = (await res.json() as any);
        expect(body.tenantSlug).toBe('acme');
        expect(body.tenantSource).toBe('subdomain');
        expect(body.studioId).toBe(ACME_STUDIO_ID);
        expect(studioBySlug).toHaveBeenCalledWith('acme');
    });

    /* ---------------------------------------------------------------- */
    /*  2. Subdomain mismatch â†’ 404 tenant_mismatch                     */
    /* ---------------------------------------------------------------- */

    it('subdomain host mismatches JWT claim â†’ 404 Problem Details tenant_mismatch', async () => {
        const studioBySlug: StudioSlugResolver = vi.fn(async (slug) => {
            if (slug === 'acme') return ACME_STUDIO_ID;
            if (slug === 'beta') return BETA_STUDIO_ID;
            return null;
        });
        const app = buildPipelineApp(studioBySlug);
        // JWT is for `beta`, but the host claims `acme`.
        const token = await mintJwtForStudio(BETA_STUDIO_ID);

        const res = await app.request(
            'http://acme.athlya.app/v1/test/me',
            {
                method: 'GET',
                headers: { authorization: `Bearer ${token}` },
            },
            envFor(),
        );

        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toBe(
            'application/problem+json',
        );
        const body = (await res.json() as any);
        expect(body.code).toBe('tenant_mismatch');
        expect(body.title).toBe('Not Found');
        expect(body.type).toBe('about:blank');
        expect(studioBySlug).toHaveBeenCalledWith('acme');
    });

    /* ---------------------------------------------------------------- */
    /*  3. Path prefix matches JWT claim â†’ 200                          */
    /* ---------------------------------------------------------------- */

    it('path slug `/s/acme/...` matches JWT claim â†’ 200 (tenantSource=path)', async () => {
        const studioBySlug: StudioSlugResolver = vi.fn(async (slug) => {
            if (slug === 'acme') return ACME_STUDIO_ID;
            return null;
        });
        const app = buildPipelineApp(studioBySlug);
        const token = await mintJwtForStudio(ACME_STUDIO_ID);

        const res = await app.request(
            'http://api.athlya.app/s/acme/v1/test/me',
            {
                method: 'GET',
                headers: { authorization: `Bearer ${token}` },
            },
            envFor(),
        );

        expect(res.status).toBe(200);
        const body = (await res.json() as any);
        expect(body.tenantSlug).toBe('acme');
        expect(body.tenantSource).toBe('path');
        expect(studioBySlug).toHaveBeenCalledWith('acme');
    });

    /* ---------------------------------------------------------------- */
    /*  4. Apex / `none` source â€” guard is a no-op                      */
    /* ---------------------------------------------------------------- */

    it('apex host (mobile case) â†’ resolver yields none â†’ guard skipped', async () => {
        // The slug resolver is wired to ALWAYS throw; if the guard
        // ever calls it, the test fails â€” which is the exact
        // assertion we want for a `'none'` resolution.
        const studioBySlug: StudioSlugResolver = vi.fn(async () => {
            throw new Error('resolveStudioBySlug called for apex host');
        });
        const app = buildPipelineApp(studioBySlug);
        const token = await mintJwtForStudio(ACME_STUDIO_ID);

        const res = await app.request(
            // `api.athlya.app` is in the resolver's reserved list, so
            // it returns `'none'`. We send a Bearer token to prove
            // the guard is NOT triggering on the slug â€” but no
            // jwtAuth middleware fires either (the wrapper bails
            // before the inline challenge when slug is undefined).
            'http://api.athlya.app/v1/test/me',
            {
                method: 'GET',
                headers: { authorization: `Bearer ${token}` },
            },
            envFor(),
        );

        expect(res.status).toBe(200);
        const body = (await res.json() as any);
        expect(body.tenantSource).toBe('none');
        expect(body.tenantSlug).toBeNull();
        // Resolver MUST NOT have fired â€” the guard short-circuits on
        // `tenantSlug === undefined`.
        expect(studioBySlug).not.toHaveBeenCalled();
    });

    /* ---------------------------------------------------------------- */
    /*  5. Pre-auth route bypass                                        */
    /* ---------------------------------------------------------------- */

    it('/v1/auth/login bypasses the cross-check (pre-auth, no claim)', async () => {
        // Even with a deliberately broken resolver, the bypass
        // prefix must let the request reach the login handler.
        const studioBySlug: StudioSlugResolver = vi.fn(async () => {
            throw new Error(
                'resolveStudioBySlug should never run on /v1/auth/*',
            );
        });
        const app = buildPipelineApp(studioBySlug);

        // Critically: NO Authorization header AND a host that would
        // normally trigger the cross-check (`acme.athlya.app`). The
        // bypass means the guard does not fire on this prefix.
        const res = await app.request(
            'http://acme.athlya.app/v1/auth/login',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            },
            envFor(),
        );

        expect(res.status).toBe(200);
        const body = (await res.json() as any);
        expect(body.route).toBe('login');
        expect(studioBySlug).not.toHaveBeenCalled();
    });

    /* ---------------------------------------------------------------- */
    /*  6. DB unavailable â†’ fail-open + warn                            */
    /* ---------------------------------------------------------------- */

    it('resolver throws (DB unavailable) â†’ 200 fail-open + warn line', async () => {
        const dbError = new Error('postgres connection refused');
        const studioBySlug: StudioSlugResolver = vi.fn(async () => {
            throw dbError;
        });
        const app = buildPipelineApp(studioBySlug);
        const token = await mintJwtForStudio(ACME_STUDIO_ID);

        const res = await app.request(
            'http://acme.athlya.app/v1/test/me',
            {
                method: 'GET',
                headers: { authorization: `Bearer ${token}` },
            },
            envFor(),
        );

        // Fail-open: the request reaches the handler.
        expect(res.status).toBe(200);
        const body = (await res.json() as any);
        expect(body.tenantSlug).toBe('acme');
        expect(body.tenantSource).toBe('subdomain');
        expect(studioBySlug).toHaveBeenCalledTimes(1);

        // The structured logger writes a `warn` line. Our minimal
        // logger middleware forwards through `console.warn` so the
        // spy captures it.
        const warned = warnSpy.mock.calls.some((call) => {
            const raw: unknown = (call as unknown[])[0];
            if (typeof raw !== 'string') return false;
            try {
                const parsed = JSON.parse(raw) as {
                    msg?: unknown;
                    level?: unknown;
                };
                return (
                    parsed.msg ===
                    'tenant claim guard: studio lookup failed, failing open' &&
                    parsed.level === 'warn'
                );
            } catch {
                return false;
            }
        });
        expect(warned).toBe(true);
    });
});

/* ================================================================== */
/*  tenantResolverMiddleware in isolation                              */
/* ================================================================== */

describe('tenantResolverMiddleware â€” context stamping', () => {
    it('stamps tenantSlug + tenantSource on a path-prefixed request', async () => {
        const app = new Hono<HonoEnv>();
        app.use('*', tenantResolverMiddleware());
        app.get('/s/acme/v1/probe', (c) =>
            c.json({
                tenantSlug: c.get('tenantSlug') ?? null,
                tenantSource: c.get('tenantSource') ?? null,
            }),
        );

        const res = await app.request(
            'http://api.athlya.app/s/acme/v1/probe',
            { method: 'GET' },
            buildMockEnv(),
        );
        const body = (await res.json() as any);
        expect(body.tenantSlug).toBe('acme');
        expect(body.tenantSource).toBe('path');
    });

    it('stamps tenantSource=subdomain on an `acme.athlya.app` request', async () => {
        const app = new Hono<HonoEnv>();
        app.use('*', tenantResolverMiddleware());
        app.get('/v1/probe', (c) =>
            c.json({
                tenantSlug: c.get('tenantSlug') ?? null,
                tenantSource: c.get('tenantSource') ?? null,
            }),
        );

        const res = await app.request(
            'http://acme.athlya.app/v1/probe',
            { method: 'GET' },
            buildMockEnv(),
        );
        const body = (await res.json() as any);
        expect(body.tenantSlug).toBe('acme');
        expect(body.tenantSource).toBe('subdomain');
    });

    it('stamps tenantSource=none and leaves tenantSlug undefined for localhost', async () => {
        const app = new Hono<HonoEnv>();
        app.use('*', tenantResolverMiddleware());
        app.get('/v1/probe', (c) =>
            c.json({
                tenantSlug: c.get('tenantSlug') ?? null,
                tenantSource: c.get('tenantSource') ?? null,
            }),
        );

        const res = await app.request(
            'http://localhost/v1/probe',
            { method: 'GET' },
            buildMockEnv(),
        );
        const body = (await res.json() as any);
        expect(body.tenantSlug).toBeNull();
        expect(body.tenantSource).toBe('none');
    });
});
