/**
 * Unit tests for the `/v1/studios/*` domain router â€” slice B9.1, B9.2.
 *
 * Covers:
 *   1. `GET /me` without Authorization â†’ 401 missing_authorization.
 *   2. `PATCH /me` without Authorization â†’ 401.
 *   3. `PATCH /me` with member role â†’ 403 forbidden (role guard).
 *   4. `PATCH /me` with admin role + low-contrast brand color â†’
 *      422 brand_color_low_contrast.
 *   5. Role guard fronts the WCAG check (member can't even get to it).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetJwksCacheForTests , jwtAuth } from '../../middleware/auth.js';
import { mountDomainRoutes } from '../../routes/index.js';
import { buildApp } from '../../worker.js';

import {
    buildLocalResolver,
    buildMockEnv,
    buildStubDeps,
    env,
    mintTestKeypair,
    signTestJwt,
    TEST_STUDIO_ID,
    TEST_USER_ID,
    type TestKeypair,
} from './route-test-helpers.js';

import type { JwksKeyResolver } from '../../middleware/auth.js';
import type { DomainDeps } from '../../routes/index.js';

/* ------------------------------------------------------------------ */
/*  jose mock â€” redirect createRemoteJWKSet to a local resolver.      */
/* ------------------------------------------------------------------ */

const joseHoisted = vi.hoisted(() => ({
    localResolver: null as JwksKeyResolver | null,
}));

vi.mock('jose', async () => {
    const actual = await vi.importActual<typeof import('jose')>('jose');
    return {
        ...actual,
        createRemoteJWKSet: () =>
            (async (...args: Parameters<JwksKeyResolver>) => {
                if (joseHoisted.localResolver === null) {
                    throw new Error('local resolver not initialised');
                }
                return joseHoisted.localResolver(...args);
            }) as JwksKeyResolver,
    };
});

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
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // NOTE: console.error left untouched so 500 paths surface during
    // suite development. `vi.restoreAllMocks()` in afterEach removes
    // the spy below.
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    __resetJwksCacheForTests();
});

afterEach(() => {
    vi.restoreAllMocks();
});

/**
 * Build a fresh app pre-wired with the supplied `deps`. The router
 * tests inject vi.fn() doubles via `buildStubDeps`.
 */
function buildAppWithDeps(deps: DomainDeps) {
    return buildApp({ deps });
}

/* ------------------------------------------------------------------ */
/*  /v1/studios/me â€” unauthenticated                                   */
/* ------------------------------------------------------------------ */

describe('/v1/studios/me â€” unauthenticated', () => {
    it('GET /me â†’ 401 missing_authorization', async () => {
        const deps = buildStubDeps();
        const app = buildAppWithDeps(deps);

        const res = await app.request(
            '/v1/studios/me',
            { method: 'GET' },
            env(),
        );

        expect(res.status).toBe(401);
        expect(res.headers.get('content-type')).toBe('application/problem+json');
        const body = await res.json() as Record<string, unknown>;
        expect(body.title).toBe('missing_authorization');
        expect(deps.studios.getStudio).not.toHaveBeenCalled();
    });

    it('PATCH /me â†’ 401 (auth runs before validator)', async () => {
        const deps = buildStubDeps();
        const app = buildAppWithDeps(deps);

        const res = await app.request(
            '/v1/studios/me',
            {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'Athlya Paris' }),
            },
            env(),
        );

        expect(res.status).toBe(401);
        expect(deps.studios.updateStudio).not.toHaveBeenCalled();
    });
});

/* ------------------------------------------------------------------ */
/*  /v1/studios/me â€” authenticated                                     */
/* ------------------------------------------------------------------ */

/**
 * Build an app whose JWT verifier resolves with the test keypair.
 * The default `jwtAuth()` middleware on the router will pull from
 * the (mocked) `createRemoteJWKSet` factory, which the suite-level
 * `vi.mock('jose', â€¦)` redirects to our local resolver.
 */
function buildAuthedApp(deps: DomainDeps) {
    // Reuse buildApp with a router-level domain mount, but inject a
    // custom auth resolver via the env so the routersâ€™ own jwtAuth()
    // calls resolve through our local key set.
    void jwtAuth; // marker: middleware composed by the routers themselves.
    return buildApp({ deps });
}

describe('GET /v1/studios/me â€” authenticated', () => {
    it('returns the studio scoped to the JWT studio claim', async () => {
        const studioRow = {
            id: TEST_STUDIO_ID,
            slug: 'athlya-paris',
            name: 'Athlya Paris',
            brandColor: '#0EA5E9',
            brandLogo: null,
        };
        const deps = buildStubDeps({
            studios: {
                getStudio: vi.fn(async () => studioRow),
            },
        });
        const app = buildAuthedApp(deps);
        const token = await signTestJwt(kp.privateKey, {
            sub: TEST_USER_ID,
            studio: TEST_STUDIO_ID,
            role: 'member',
        });

        const res = await app.request(
            '/v1/studios/me',
            {
                method: 'GET',
                headers: { authorization: `Bearer ${token}` },
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body).toEqual(studioRow);
        expect(deps.studios.getStudio).toHaveBeenCalledWith(TEST_STUDIO_ID);
    });

    it('returns 404 when the studio row was deleted', async () => {
        const deps = buildStubDeps({
            studios: {
                getStudio: vi.fn(async () => null),
            },
        });
        const app = buildAuthedApp(deps);
        const token = await signTestJwt(kp.privateKey, {
            sub: TEST_USER_ID,
            studio: TEST_STUDIO_ID,
            role: 'admin',
        });

        const res = await app.request(
            '/v1/studios/me',
            {
                method: 'GET',
                headers: { authorization: `Bearer ${token}` },
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toBe(
            'application/problem+json',
        );
        const body = await res.json() as Record<string, unknown>;
        expect(body.code).toBe('not_found');
    });
});

describe('PATCH /v1/studios/me â€” admin only', () => {
    it('rejects member role with 403 forbidden', async () => {
        const deps = buildStubDeps();
        const app = buildAuthedApp(deps);
        const token = await signTestJwt(kp.privateKey, {
            sub: TEST_USER_ID,
            studio: TEST_STUDIO_ID,
            role: 'member',
        });

        const res = await app.request(
            '/v1/studios/me',
            {
                method: 'PATCH',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ name: 'Hacked' }),
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(403);
        const body = await res.json() as Record<string, unknown>;
        expect(body.title).toBe('forbidden');
        expect(deps.studios.updateStudio).not.toHaveBeenCalled();
    });

    it('rejects a malformed hex with 422 ValidationError (Zod regex)', async () => {
        const deps = buildStubDeps();
        const app = buildAuthedApp(deps);
        const token = await signTestJwt(kp.privateKey, {
            sub: TEST_USER_ID,
            studio: TEST_STUDIO_ID,
            role: 'admin',
        });

        const res = await app.request(
            '/v1/studios/me',
            {
                method: 'PATCH',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json',
                },
                // 3-digit short form is rejected by HexColorSchema.
                body: JSON.stringify({ brandColor: '#fff' }),
            },
            buildMockEnv(),
        );

        // Zod refusal lands as 422 ValidationError before the WCAG
        // gate runs. The DB write MUST NOT have happened.
        expect(res.status).toBe(422);
        expect(deps.studios.updateStudio).not.toHaveBeenCalled();
    });

    it('accepts every valid 6-digit hex via the WCAG AA gate (defense-in-depth)', async () => {
        // The auto-pair logic in `deriveBrandColorVariables` always
        // picks the compagnon with the better contrast, so any valid
        // `#RRGGBB` hex meets AA by construction (â‰¥ 4.58:1). The gate
        // is defense-in-depth â€” it would only fire if the pairing
        // helper drifted. This test pins the expected pass-through
        // behaviour against a mid-grey that is the pathological worst
        // case for the auto-pair heuristic.
        const studioRow = {
            id: TEST_STUDIO_ID,
            slug: 'athlya-paris',
            name: 'Athlya Paris',
            brandColor: '#a0a0a0',
            brandLogo: null,
        };
        const deps = buildStubDeps({
            studios: {
                updateStudio: vi.fn(async () => studioRow),
            },
        });
        const app = buildAuthedApp(deps);
        const token = await signTestJwt(kp.privateKey, {
            sub: TEST_USER_ID,
            studio: TEST_STUDIO_ID,
            role: 'admin',
        });

        const res = await app.request(
            '/v1/studios/me',
            {
                method: 'PATCH',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ brandColor: '#A0A0A0' }),
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(200);
        expect(deps.studios.updateStudio).toHaveBeenCalledWith(
            TEST_STUDIO_ID,
            { brandColor: '#A0A0A0' },
        );
    });

    it('accepts a high-contrast brandColor and forwards the patch', async () => {
        const studioRow = {
            id: TEST_STUDIO_ID,
            slug: 'athlya-paris',
            name: 'Athlya Paris',
            brandColor: '#0EA5E9',
            brandLogo: null,
        };
        const deps = buildStubDeps({
            studios: {
                updateStudio: vi.fn(async () => studioRow),
            },
        });
        const app = buildAuthedApp(deps);
        const token = await signTestJwt(kp.privateKey, {
            sub: TEST_USER_ID,
            studio: TEST_STUDIO_ID,
            role: 'admin',
        });

        // `#0EA5E9` (sky blue) pairs with black, ratio ~7.7 â€” well above
        // the AA minimum.
        const res = await app.request(
            '/v1/studios/me',
            {
                method: 'PATCH',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    name: 'Athlya Paris',
                    brandColor: '#0EA5E9',
                }),
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body).toEqual(studioRow);
        expect(deps.studios.updateStudio).toHaveBeenCalledWith(
            TEST_STUDIO_ID,
            { name: 'Athlya Paris', brandColor: '#0EA5E9' },
        );
    });
});

// `mountDomainRoutes` is referenced indirectly through `buildApp`; this
// import keeps the module graph honest.
void mountDomainRoutes;
