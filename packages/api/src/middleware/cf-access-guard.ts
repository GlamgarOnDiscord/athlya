/**
 * Cloudflare Access guard for `/admin/*` routes (issue #273).
 *
 * Defense-in-depth layer on top of `jwtAuth()` + `requireRole('admin')`.
 * When `CF_ACCESS_AUD` and `CF_ACCESS_CERTS_URL` are configured, every
 * request to `/admin/*` must carry a valid `CF-Access-JWT-Assertion`
 * header issued by the configured CF Access application.
 *
 * When either binding is absent (dev / unconfigured staging), the guard
 * is a no-op so local development and CI do not require CF Access setup.
 *
 * Operator setup: `docs/runbooks/cf-access-admin.md`.
 */

import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';

import type { AthlyaBindings } from '../types.js';
import type { FlattenedJWSInput, JWSHeaderParameters } from 'jose';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

/** Minimal context shape — structurally compatible with Hono Context<HonoEnv>. */
export interface CfAccessGuardContext {
  readonly env: AthlyaBindings;
  readonly req: { header(name: string): string | undefined };
  get(key: 'traceId'): string;
  get(key: string): unknown;
  body(data: string, status: 403, headers: Record<string, string>): Response;
}

export type CfAccessKeyResolver = (
  protectedHeader?: JWSHeaderParameters,
  token?: FlattenedJWSInput,
) => Promise<CryptoKey>;

/** Options for {@link cfAccessGuard} — used by tests to inject a local JWKS. */
export interface CfAccessGuardOptions {
  keyResolver?: CfAccessKeyResolver;
}

/* ------------------------------------------------------------------ */
/*  JWKS cache                                                          */
/* ------------------------------------------------------------------ */

const cfJwksGetters = new Map<string, CfAccessKeyResolver>();

function getDefaultResolver(certsUrl: string): CfAccessKeyResolver {
  const cached = cfJwksGetters.get(certsUrl);
  if (cached !== undefined) return cached;
  const getter = createRemoteJWKSet(new URL(certsUrl), {
    cacheMaxAge: 10 * 60 * 1_000,
    cooldownDuration: 30 * 1_000,
  });
  cfJwksGetters.set(certsUrl, getter);
  return getter;
}

export function __resetCfAccessJwksCacheForTests(): void {
  cfJwksGetters.clear();
}

/* ------------------------------------------------------------------ */
/*  Problem Details helper                                             */
/* ------------------------------------------------------------------ */

const PROBLEM_JSON = 'application/problem+json';

function respond403(c: CfAccessGuardContext, code: string): Response {
  return c.body(
    JSON.stringify({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      code,
      traceId: c.get('traceId'),
    }),
    403,
    { 'content-type': PROBLEM_JSON },
  );
}

/* ------------------------------------------------------------------ */
/*  Middleware factory                                                  */
/* ------------------------------------------------------------------ */

/**
 * Build a Hono-compatible middleware that enforces a Cloudflare Access
 * JWT on the `CF-Access-JWT-Assertion` header.
 *
 * - No-op when `CF_ACCESS_AUD` or `CF_ACCESS_CERTS_URL` is absent.
 * - Verifies RS256 signature + `aud` claim using the CF Access JWKS.
 * - Returns 403 `cf_access_required` when the header is missing.
 * - Returns 403 `cf_access_invalid` when the JWT is malformed or expired.
 */
export function cfAccessGuard(opts: CfAccessGuardOptions = {}) {
  return async (c: CfAccessGuardContext, next: () => Promise<void>): Promise<Response | void> => {
    const env = c.env as AthlyaBindings & {
      CF_ACCESS_AUD?: string;
      CF_ACCESS_CERTS_URL?: string;
    };

    const aud = env.CF_ACCESS_AUD;
    const certsUrl = env.CF_ACCESS_CERTS_URL;

    if (!aud || !certsUrl) {
      await next();
      return undefined;
    }

    const assertion = c.req.header('CF-Access-JWT-Assertion');
    if (!assertion) {
      return respond403(c, 'cf_access_required');
    }

    const keyResolver = opts.keyResolver ?? getDefaultResolver(certsUrl);

    try {
      await jwtVerify(assertion, keyResolver, {
        audience: aud,
        algorithms: ['RS256'],
      });
    } catch (err) {
      if (
        err instanceof joseErrors.JWTExpired ||
        err instanceof joseErrors.JWSSignatureVerificationFailed ||
        err instanceof joseErrors.JWTClaimValidationFailed ||
        err instanceof joseErrors.JWSInvalid ||
        err instanceof joseErrors.JWTInvalid
      ) {
        return respond403(c, 'cf_access_invalid');
      }
      throw err;
    }

    await next();
    return undefined;
  };
}
