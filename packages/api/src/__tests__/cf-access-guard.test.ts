/**
 * Issue #273 — CF Access guard on /admin/* routes.
 *
 * Tests use a local JWKS (createLocalJWKSet) so no network I/O happens.
 * The remote JWKS path is covered by jose's own test suite.
 */

import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  __resetCfAccessJwksCacheForTests,
  cfAccessGuard,
  type CfAccessGuardContext,
  type CfAccessKeyResolver,
} from '../middleware/cf-access-guard.js';

/* ------------------------------------------------------------------ */
/*  Test key setup                                                      */
/* ------------------------------------------------------------------ */

const TEST_AUD = 'test-cf-access-aud-uuid';

async function buildTestKeys() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  const jwks = { keys: [{ ...publicJwk, kid: 'cf-test', use: 'sig', alg: 'RS256' }] };
  const resolver = createLocalJWKSet(jwks);

  async function signJwt(aud: string, expOffset = 300) {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'cf-test' })
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expOffset)
      .sign(privateKey);
  }

  return { resolver, signJwt };
}

/* ------------------------------------------------------------------ */
/*  Context factory                                                     */
/* ------------------------------------------------------------------ */

function buildCtx(overrides: {
  assertionHeader?: string;
  cfAccessAud?: string;
  cfAccessCertsUrl?: string;
}): CfAccessGuardContext {
  return {
    env: {
      CF_ACCESS_AUD: overrides.cfAccessAud,
      CF_ACCESS_CERTS_URL: overrides.cfAccessCertsUrl,
    } as CfAccessGuardContext['env'],
    req: {
      header(name: string) {
        if (name === 'CF-Access-JWT-Assertion') return overrides.assertionHeader;
        return undefined;
      },
    },
    get: ((key: string) =>
      key === 'traceId' ? 'test-trace-id' : undefined) as CfAccessGuardContext['get'],
    body(data: string, status: 403, headers: Record<string, string>) {
      return new Response(data, { status, headers });
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                               */
/* ------------------------------------------------------------------ */

describe('cfAccessGuard middleware', () => {
  beforeEach(() => {
    __resetCfAccessJwksCacheForTests();
  });

  it('is a no-op when CF_ACCESS_AUD is absent', async () => {
    const mw = cfAccessGuard();
    let nextCalled = false;
    const ctx = buildCtx({
      cfAccessCertsUrl: 'https://test.cloudflareaccess.com/cdn-cgi/access/certs',
    });
    const res = await mw(ctx, async () => {
      nextCalled = true;
    });
    expect(res).toBeUndefined();
    expect(nextCalled).toBe(true);
  });

  it('is a no-op when CF_ACCESS_CERTS_URL is absent', async () => {
    const mw = cfAccessGuard();
    let nextCalled = false;
    const ctx = buildCtx({ cfAccessAud: TEST_AUD });
    const res = await mw(ctx, async () => {
      nextCalled = true;
    });
    expect(res).toBeUndefined();
    expect(nextCalled).toBe(true);
  });

  it('returns 403 cf_access_required when header is missing', async () => {
    const neverCalled: CfAccessKeyResolver = async () => {
      throw new Error('should not call');
    };
    const mw = cfAccessGuard({ keyResolver: neverCalled });
    const ctx = buildCtx({
      cfAccessAud: TEST_AUD,
      cfAccessCertsUrl: 'https://test.cloudflareaccess.com/cdn-cgi/access/certs',
    });
    const res = await mw(ctx, async () => {
      /* noop */
    });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(403);
    const body = await (res as Response).json<{ code: string }>();
    expect(body.code).toBe('cf_access_required');
  });

  it('passes through with a valid CF Access JWT', async () => {
    const { resolver, signJwt } = await buildTestKeys();
    const jwt = await signJwt(TEST_AUD);
    const mw = cfAccessGuard({ keyResolver: resolver });
    let nextCalled = false;
    const ctx = buildCtx({
      cfAccessAud: TEST_AUD,
      cfAccessCertsUrl: 'https://test.cloudflareaccess.com/cdn-cgi/access/certs',
      assertionHeader: jwt,
    });
    const res = await mw(ctx, async () => {
      nextCalled = true;
    });
    expect(res).toBeUndefined();
    expect(nextCalled).toBe(true);
  });

  it('returns 403 cf_access_invalid when audience does not match', async () => {
    const { resolver, signJwt } = await buildTestKeys();
    const jwt = await signJwt('wrong-aud');
    const mw = cfAccessGuard({ keyResolver: resolver });
    const ctx = buildCtx({
      cfAccessAud: TEST_AUD,
      cfAccessCertsUrl: 'https://test.cloudflareaccess.com/cdn-cgi/access/certs',
      assertionHeader: jwt,
    });
    const res = await mw(ctx, async () => {
      /* noop */
    });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(403);
    const body = await (res as Response).json<{ code: string }>();
    expect(body.code).toBe('cf_access_invalid');
  });

  it('returns 403 cf_access_invalid when JWT is expired', async () => {
    const { resolver, signJwt } = await buildTestKeys();
    const jwt = await signJwt(TEST_AUD, -10);
    const mw = cfAccessGuard({ keyResolver: resolver });
    const ctx = buildCtx({
      cfAccessAud: TEST_AUD,
      cfAccessCertsUrl: 'https://test.cloudflareaccess.com/cdn-cgi/access/certs',
      assertionHeader: jwt,
    });
    const res = await mw(ctx, async () => {
      /* noop */
    });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(403);
    const body = await (res as Response).json<{ code: string }>();
    expect(body.code).toBe('cf_access_invalid');
  });

  it('returns 403 cf_access_invalid when JWT is malformed', async () => {
    const { resolver } = await buildTestKeys();
    const mw = cfAccessGuard({ keyResolver: resolver });
    const ctx = buildCtx({
      cfAccessAud: TEST_AUD,
      cfAccessCertsUrl: 'https://test.cloudflareaccess.com/cdn-cgi/access/certs',
      assertionHeader: 'not.a.jwt',
    });
    const res = await mw(ctx, async () => {
      /* noop */
    });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(403);
  });
});
