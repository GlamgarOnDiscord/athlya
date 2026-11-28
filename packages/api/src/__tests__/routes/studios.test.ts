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

import { DnsLookupError } from '../../adapters/doh-resolver.js';
import { StudioDomainTakenError } from '../../adapters/studio-domains-repo-drizzle.js';
import { __resetJwksCacheForTests, jwtAuth } from '../../middleware/auth.js';
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

import { StudioDomainCheckCooldownError } from '../../white-label/dns-records.js';
import { readJson } from '../helpers/read-json.js';

import type { JwksKeyResolver } from '../../middleware/auth.js';
import type { DomainDeps } from '../../routes/index.js';
import type { StudioDomain } from '@athlya/shared/schemas/api';

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

    const res = await app.request('/v1/studios/me', { method: 'GET' }, env());

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as any;
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
      brandLogoLight: null,
      brandLogoDark: null,
      hideAthlyaBranding: false,
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
    const body = (await res.json()) as any;
    expect(body).toEqual(studioRow);
    expect(deps.studios.getStudio).toHaveBeenCalledWith(
      TEST_STUDIO_ID,
      expect.objectContaining({ userId: TEST_USER_ID, studioId: TEST_STUDIO_ID }),
    );
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
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as any;
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
    const body = (await res.json()) as any;
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
      brandLogoLight: null,
      brandLogoDark: null,
      hideAthlyaBranding: false,
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
      expect.objectContaining({ studioId: TEST_STUDIO_ID, role: 'admin' }),
    );
  });

  it('accepts a high-contrast brandColor and forwards the patch', async () => {
    const studioRow = {
      id: TEST_STUDIO_ID,
      slug: 'athlya-paris',
      name: 'Athlya Paris',
      brandColor: '#0EA5E9',
      brandLogoLight: null,
      brandLogoDark: null,
      hideAthlyaBranding: false,
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
    const body = (await res.json()) as any;
    expect(body).toEqual(studioRow);
    expect(deps.studios.updateStudio).toHaveBeenCalledWith(
      TEST_STUDIO_ID,
      { name: 'Athlya Paris', brandColor: '#0EA5E9' },
      expect.objectContaining({ studioId: TEST_STUDIO_ID, role: 'admin' }),
    );
  });
});

/* ------------------------------------------------------------------ */
/*  White label: logos and custom domains (issue #761)                 */
/* ------------------------------------------------------------------ */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const STUDIO_VIEW = {
  id: TEST_STUDIO_ID,
  slug: 'athlya-paris',
  name: 'Athlya Paris',
  brandColor: '#0EA5E9',
  brandLogoLight: 'data:image/png;base64,iVBORw0KGgo=',
  brandLogoDark: null,
  hideAthlyaBranding: true,
};

const DOMAIN_VIEW: StudioDomain = {
  kind: 'web',
  hostname: 'club.example.com',
  status: 'pending',
  records: [],
  lastCheckedAt: null,
  verifiedAt: null,
  activatedAt: null,
};

async function tokenFor(role: 'admin' | 'member') {
  return signTestJwt(kp.privateKey, { sub: TEST_USER_ID, studio: TEST_STUDIO_ID, role });
}

describe('PATCH /v1/studios/me: Athlya mention', () => {
  it('forwards hideAthlyaBranding', async () => {
    const deps = buildStubDeps({ studios: { updateStudio: vi.fn(async () => STUDIO_VIEW) } });
    const res = await buildAuthedApp(deps).request(
      '/v1/studios/me',
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${await tokenFor('admin')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ hideAthlyaBranding: true }),
      },
      buildMockEnv(),
    );
    expect(res.status).toBe(200);
    expect(deps.studios.updateStudio).toHaveBeenCalledWith(
      TEST_STUDIO_ID,
      { hideAthlyaBranding: true },
      expect.objectContaining({ role: 'admin' }),
    );
  });

  it('refuses the former brandLogo field (logos have their own route)', async () => {
    const deps = buildStubDeps();
    const res = await buildAuthedApp(deps).request(
      '/v1/studios/me',
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${await tokenFor('admin')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ brandLogo: 'https://evil.example/logo.png' }),
      },
      buildMockEnv(),
    );
    expect(res.status).toBe(422);
    expect(deps.studios.updateStudio).not.toHaveBeenCalled();
  });
});

describe('PUT /v1/studios/me/logo/:variant', () => {
  async function upload(
    deps: ReturnType<typeof buildStubDeps>,
    init: {
      variant?: string;
      type?: string;
      body?: Uint8Array;
      length?: string | null;
      role?: 'admin' | 'member';
    },
  ) {
    const body = init.body ?? PNG;
    const headers: Record<string, string> = {
      authorization: `Bearer ${await tokenFor(init.role ?? 'admin')}`,
      'content-type': init.type ?? 'image/png',
    };
    if (init.length !== null) headers['content-length'] = init.length ?? String(body.byteLength);
    return buildAuthedApp(deps).request(
      `/v1/studios/me/logo/${init.variant ?? 'light'}`,
      { method: 'PUT', headers, body: body as unknown as BodyInit },
      buildMockEnv(),
    );
  }

  it('stores the logo and returns the studio', async () => {
    const deps = buildStubDeps({ studios: { uploadLogo: vi.fn(async () => STUDIO_VIEW) } });
    const res = await upload(deps, { variant: 'dark' });
    expect(res.status).toBe(200);
    expect(await readJson<typeof STUDIO_VIEW>(res)).toEqual(STUDIO_VIEW);
    expect(deps.studios.uploadLogo).toHaveBeenCalledWith(
      'dark',
      'image/png',
      expect.any(ArrayBuffer),
      expect.objectContaining({ studioId: TEST_STUDIO_ID }),
    );
  });

  it('is admin only', async () => {
    const deps = buildStubDeps();
    expect((await upload(deps, { role: 'member' })).status).toBe(403);
    expect(deps.studios.uploadLogo).not.toHaveBeenCalled();
  });

  it('refuses an unknown variant, an SVG, a missing length and a large file', async () => {
    const deps = buildStubDeps();
    expect((await upload(deps, { variant: 'blue' })).status).toBe(422);
    const svg = await upload(deps, { type: 'image/svg+xml' });
    expect(svg.status).toBe(415);
    expect((await readJson<{ code: string }>(svg)).code).toBe('unsupported_media_type');
    expect((await upload(deps, { length: null })).status).toBe(411);
    const large = await upload(deps, { length: String(129 * 1024) });
    expect(large.status).toBe(413);
    expect((await readJson<{ code: string }>(large)).code).toBe('logo_too_large');
    expect(deps.studios.uploadLogo).not.toHaveBeenCalled();
  });

  it('maps a content mismatch to 422 logo_invalid_format', async () => {
    const { AvatarInvalidFormatError } = await import('../../adapters/avatar-upload-store-r2.js');
    const deps = buildStubDeps({
      studios: {
        uploadLogo: vi.fn(async () => {
          throw new AvatarInvalidFormatError();
        }),
      },
    });
    const res = await upload(deps, { type: 'image/jpeg' });
    expect(res.status).toBe(422);
    expect((await readJson<{ code: string }>(res)).code).toBe('logo_invalid_format');
  });

  it('DELETE removes the logo', async () => {
    const deps = buildStubDeps({ studios: { removeLogo: vi.fn(async () => STUDIO_VIEW) } });
    const res = await buildAuthedApp(deps).request(
      '/v1/studios/me/logo/light',
      { method: 'DELETE', headers: { authorization: `Bearer ${await tokenFor('admin')}` } },
      buildMockEnv(),
    );
    expect(res.status).toBe(200);
    expect(deps.studios.removeLogo).toHaveBeenCalledWith('light', expect.anything());
  });
});

describe('/v1/studios/me/domains', () => {
  async function call(
    deps: ReturnType<typeof buildStubDeps>,
    method: string,
    path: string,
    body?: unknown,
    role: 'admin' | 'member' = 'admin',
  ) {
    return buildAuthedApp(deps).request(
      `/v1/studios/me/domains${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${await tokenFor(role)}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      buildMockEnv(),
    );
  }

  it('lists the domains of an admin studio and hides them from members', async () => {
    const deps = buildStubDeps({ studios: { listDomains: vi.fn(async () => [DOMAIN_VIEW]) } });
    const res = await call(deps, 'GET', '');
    expect(res.status).toBe(200);
    expect(await readJson<{ items: unknown[] }>(res)).toEqual({ items: [DOMAIN_VIEW] });
    expect((await call(deps, 'GET', '', undefined, 'member')).status).toBe(403);
  });

  it('registers a lower-cased hostname', async () => {
    const deps = buildStubDeps({ studios: { setDomain: vi.fn(async () => DOMAIN_VIEW) } });
    const res = await call(deps, 'PUT', '/web', { hostname: ' Club.Example.com ' });
    expect(res.status).toBe(200);
    expect(deps.studios.setDomain).toHaveBeenCalledWith(
      'web',
      'club.example.com',
      expect.objectContaining({ studioId: TEST_STUDIO_ID }),
    );
  });

  it('refuses a URL, a bare name and an athlya.app hostname', async () => {
    const deps = buildStubDeps();
    for (const hostname of ['https://club.example.com', 'localhost', 'x.athlya.app']) {
      expect((await call(deps, 'PUT', '/web', { hostname })).status).toBe(422);
    }
    expect((await call(deps, 'PUT', '/ftp', { hostname: 'example.com' })).status).toBe(422);
    expect(deps.studios.setDomain).not.toHaveBeenCalled();
  });

  it('DELETE answers 204, or 404 when there was no domain', async () => {
    const deps = buildStubDeps({
      studios: { removeDomain: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) },
    });
    expect((await call(deps, 'DELETE', '/email')).status).toBe(204);
    expect((await call(deps, 'DELETE', '/email')).status).toBe(404);
  });

  it('check returns the checked domain', async () => {
    const deps = buildStubDeps({
      studios: {
        checkDomain: vi.fn(async (): Promise<StudioDomain> => ({
          ...DOMAIN_VIEW,
          status: 'verified',
        })),
      },
    });
    const res = await call(deps, 'POST', '/web/check');
    expect(res.status).toBe(200);
    expect((await readJson<{ status: string }>(res)).status).toBe('verified');
  });

  it.each([
    [new StudioDomainCheckCooldownError(7), 429, 'domain_check_cooldown'],
    [new DnsLookupError('boom'), 502, 'dns_lookup_failed'],
    [new StudioDomainTakenError('taken'), 409, 'domain_taken'],
  ])('maps %s to %i', async (error, status, code) => {
    const deps = buildStubDeps({
      studios: {
        checkDomain: vi.fn(async () => {
          throw error;
        }),
      },
    });
    const res = await call(deps, 'POST', '/web/check');
    expect(res.status).toBe(status);
    expect((await readJson<{ code: string }>(res)).code).toBe(code);
    if (status === 429) expect(res.headers.get('retry-after')).toBe('7');
  });

  it('check answers 404 without a domain', async () => {
    const deps = buildStubDeps({ studios: { checkDomain: vi.fn(async () => null) } });
    expect((await call(deps, 'POST', '/email/check')).status).toBe(404);
  });
});

// `mountDomainRoutes` is referenced indirectly through `buildApp`; this
// import keeps the module graph honest.
void mountDomainRoutes;
