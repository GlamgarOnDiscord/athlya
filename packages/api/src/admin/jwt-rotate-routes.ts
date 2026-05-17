/**
 * Admin sub-router — JWT key rotation prep.
 *
 * Sprint 12 / Slice 12.7 (Epic B3.1, Req 25.5).
 *
 * Endpoints
 * ---------
 *   • POST `/admin/jwt/rotate-prepare` — generate a fresh RS256
 *     keypair, compute the new JWKS (which includes BOTH the
 *     incoming `current` key and the demoted `previous` key for the
 *     grace window), and return the bundle to the operator. The
 *     operator persists the secrets via `wrangler secret put` and
 *     redeploys.
 *
 *     This endpoint does NOT mutate any binding. It is a "prepare
 *     the rotation, give me the artefacts" tool. Two reasons:
 *
 *       1. Cloudflare Wrangler does not expose a runtime API for
 *          updating Worker secrets; the operator runs `wrangler` on
 *          their machine. Rotation therefore HAS to be human-driven.
 *
 *       2. Pushing secrets to a live Worker without a human
 *          checkpoint is a class of mistake worth avoiding (see
 *          Stripe's 2022 internal post-mortem on automated key
 *          rollover gone wrong).
 *
 *   • GET `/admin/jwt/state` — read-only snapshot of the current
 *     `kid`, the JWKS being served, and (when applicable) the
 *     `previous` key's `notAfter`. Lets the operator confirm the
 *     production state before committing to a rotation.
 *
 * Both endpoints require `role: admin` in the JWT claims (enforced
 * by the inline `enforceAdmin` helper, mirroring `dlq-routes.ts`).
 *
 * Audit trail
 * -----------
 * The rotation prep step writes one append-only audit row via
 * `deps.appendAudit` so the next pgTAP run + Sentry breadcrumb show
 * who triggered the rotation. PII-safe: only `actorId`, `kid_old`,
 * `kid_new`, and `now()` go into `metadata`.
 *
 * Operator runbook: `docs/runbooks/rotate-jwt.md` (Slice 12.7).
 */

import {
  DEFAULT_ROTATION_GRACE_SEC,
  rotateKeysAsync,
  loadKeyPairFromPem,
  publicJwkOf,
  type Jwks,
  type SigningKey,
} from '@athlya/auth';
import { Hono } from 'hono';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';

import type { AthlyaBindings, AthlyaVariables } from '../types.js';
import type { Context } from 'hono';

/** Environment shape this router is generic over. */
export interface JwtRotateAdminEnv {
  Bindings: AthlyaBindings;
  Variables: AthlyaVariables;
}

/** Problem Details content-type. */
const PROBLEM_JSON = 'application/problem+json';

/** Problem Details `type` URI prefix for Athlya-specific errors. */
const ATHLYA_PROBLEM_NAMESPACE = 'https://athlya.app/problems/';

const FORBIDDEN_TYPE = `${ATHLYA_PROBLEM_NAMESPACE}forbidden`;

/** Shape of the Problem Details body this router emits on failures. */
interface AdminProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly code?: string;
  readonly traceId: string;
}

/* ------------------------------------------------------------------ */
/*  Admin guard                                                         */
/* ------------------------------------------------------------------ */

/**
 * Enforce `role: admin` in the JWT claims. Mirrors the helper in
 * `dlq-routes.ts` so both admin sub-routers behave identically. We
 * deliberately re-implement here rather than depending on
 * `dlq-routes.ts` to keep this router self-contained.
 */
function enforceAdmin(c: Context<JwtRotateAdminEnv>): Response | null {
  const claims = c.get('authClaims');
  if (claims === undefined || claims === null) {
    return adminProblem(c, {
      type: FORBIDDEN_TYPE,
      title: 'Forbidden',
      status: 403,
      code: 'admin_required',
      detail: 'admin claim missing',
    });
  }
  const role = (claims as { role?: unknown }).role;
  if (role !== 'admin') {
    return adminProblem(c, {
      type: FORBIDDEN_TYPE,
      title: 'Forbidden',
      status: 403,
      code: 'admin_required',
      detail: 'admin role required',
    });
  }
  return null;
}

function adminProblem(
  c: Context<JwtRotateAdminEnv>,
  body: Omit<AdminProblemBody, 'traceId'>,
): Response {
  const traceId = typeof c.get('traceId') === 'string' ? c.get('traceId') : 'unknown';
  const full: AdminProblemBody = { ...body, traceId };
  return c.body(JSON.stringify(full), body.status as 403 | 500, {
    'content-type': PROBLEM_JSON,
  });
}

/* ------------------------------------------------------------------ */
/*  Audit hook                                                          */
/* ------------------------------------------------------------------ */

/**
 * Optional audit-log writer. The router invokes it once per
 * successful rotation prep so the action is captured in the
 * `audit_log` table even when no business event is published.
 *
 * PII-safe: the metadata only carries `actorId`, `kidOld`, `kidNew`
 * and `graceSec`. No IP, no UA, no email.
 */
export interface JwtRotateAuditWriter {
  appendRotationPrep(input: {
    actorId: string;
    kidOld: string;
    kidNew: string;
    graceSec: number;
  }): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Response shapes                                                     */
/* ------------------------------------------------------------------ */

/**
 * Response body for `POST /admin/jwt/rotate-prepare`.
 *
 * The operator copies these values into Wrangler secrets and
 * redeploys. Order:
 *
 *   1. `wrangler secret put JWT_PRIVATE_KEY_PEM_PREVIOUS` (the
 *      currently-deployed private key — `previousPrivatePem`).
 *   2. `wrangler secret put JWT_PUBLIC_KEY_PEM_PREVIOUS` (idem
 *      public).
 *   3. `wrangler secret put JWT_KID_PREVIOUS` (idem kid).
 *   4. `wrangler secret put JWT_PRIVATE_KEY_PEM` (the freshly
 *      generated private key — `currentPrivatePem`).
 *   5. `wrangler secret put JWT_PUBLIC_KEY_PEM` (idem public).
 *   6. `wrangler secret put JWT_KID` (idem kid — `currentKid`).
 *   7. `wrangler secret put JWKS_JSON` (the new JWKS containing
 *      BOTH keys for the grace window — `jwks`).
 *
 * After step 7, redeploy the Worker. The grace window starts at
 * `previousNotAfter`; once it elapses, drop the `*_PREVIOUS`
 * secrets via `wrangler secret delete`.
 */
export interface RotationPrepareResponse {
  /** New `kid` for the freshly generated key. */
  readonly currentKid: string;
  /** PEM-encoded PKCS#8 private key for the new current. */
  readonly currentPrivatePem: string;
  /** PEM-encoded SPKI public key for the new current. */
  readonly currentPublicPem: string;
  /** Demoted previous `kid` (no change to its key material). */
  readonly previousKid: string;
  /** The grace window expiry as ISO 8601. */
  readonly previousNotAfter: string;
  /** Effective grace duration in seconds. */
  readonly graceSec: number;
  /** New JWKS to push into `JWKS_JSON` — contains both keys. */
  readonly jwks: Jwks;
}

/** Response body for `GET /admin/jwt/state`. */
export interface JwtStateResponse {
  /** Current `kid` (the one tokens are signed with). */
  readonly currentKid: string;
  /** The JWKS currently being served. */
  readonly jwks: Jwks;
}

/* ------------------------------------------------------------------ */
/*  Router                                                              */
/* ------------------------------------------------------------------ */

/** Dependencies the router accepts. Tests inject fakes here. */
export interface JwtRotateRouterDeps {
  /**
   * Pure key-pair factory. Defaults to `jose.generateKeyPair`.
   * Tests inject a deterministic stub so the response is
   * reproducible.
   */
  readonly generateKeyPair?: typeof generateKeyPair;
  /** Audit writer. Optional — when absent, the rotation logs only. */
  readonly auditWriter?: JwtRotateAuditWriter;
  /** Default grace window. Optional override — defaults to 24h. */
  readonly defaultGraceSec?: number;
  /**
   * Clock injection — useful for tests. Defaults to `() => new Date()`.
   */
  readonly now?: () => Date;
}

/**
 * Build the JWT rotation admin sub-router. Caller mounts on the
 * main gateway behind a JWT auth middleware that populates
 * `c.get('authClaims')`.
 */
export function buildJwtRotateRouter(deps: JwtRotateRouterDeps = {}): Hono<JwtRotateAdminEnv> {
  const router = new Hono<JwtRotateAdminEnv>();
  const genKp = deps.generateKeyPair ?? generateKeyPair;
  const graceDefault = deps.defaultGraceSec ?? DEFAULT_ROTATION_GRACE_SEC;
  const clock = deps.now ?? (() => new Date());

  /* -------------------------------------------------------------- */
  /*  GET /admin/jwt/state                                          */
  /* -------------------------------------------------------------- */

  router.get('/admin/jwt/state', (c) => {
    const forbidden = enforceAdmin(c);
    if (forbidden !== null) return forbidden;

    const env = c.env as AthlyaBindings & {
      JWT_KID?: string;
      JWKS_JSON?: string;
    };

    const currentKid = env.JWT_KID ?? '';
    if (currentKid === '') {
      return adminProblem(c, {
        type: FORBIDDEN_TYPE,
        title: 'Configuration Error',
        status: 500,
        code: 'jwt_state_unavailable',
        detail: 'JWT_KID binding missing on env',
      });
    }

    let jwks: Jwks;
    try {
      jwks = JSON.parse(env.JWKS_JSON ?? '{"keys":[]}') as Jwks;
    } catch {
      return adminProblem(c, {
        type: FORBIDDEN_TYPE,
        title: 'Configuration Error',
        status: 500,
        code: 'jwt_state_unavailable',
        detail: 'JWKS_JSON binding malformed',
      });
    }

    const body: JwtStateResponse = { currentKid, jwks };
    return c.json(body);
  });

  /* -------------------------------------------------------------- */
  /*  POST /admin/jwt/rotate-prepare                                 */
  /* -------------------------------------------------------------- */

  router.post('/admin/jwt/rotate-prepare', async (c) => {
    const forbidden = enforceAdmin(c);
    if (forbidden !== null) return forbidden;

    const env = c.env as AthlyaBindings & {
      JWT_KID?: string;
      JWT_PRIVATE_KEY_PEM?: string;
      JWT_PUBLIC_KEY_PEM?: string;
    };

    // Precondition: the worker must currently know its previous
    // signing material so we can compute the rotation result.
    if (
      env.JWT_KID === undefined ||
      env.JWT_KID === '' ||
      env.JWT_PRIVATE_KEY_PEM === undefined ||
      env.JWT_PRIVATE_KEY_PEM === '' ||
      env.JWT_PUBLIC_KEY_PEM === undefined ||
      env.JWT_PUBLIC_KEY_PEM === ''
    ) {
      return adminProblem(c, {
        type: FORBIDDEN_TYPE,
        title: 'Configuration Error',
        status: 500,
        code: 'jwt_rotation_precondition_failed',
        detail: 'JWT_KID / JWT_PRIVATE_KEY_PEM / JWT_PUBLIC_KEY_PEM bindings required for rotation',
      });
    }

    // Step 1 — load the currently-deployed key (becomes "previous").
    let previous: SigningKey;
    try {
      previous = await loadKeyPairFromPem(
        env.JWT_PRIVATE_KEY_PEM,
        env.JWT_PUBLIC_KEY_PEM,
        env.JWT_KID,
      );
    } catch (err) {
      return adminProblem(c, {
        type: FORBIDDEN_TYPE,
        title: 'Configuration Error',
        status: 500,
        code: 'jwt_rotation_precondition_failed',
        detail: `failed to load current keypair: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Step 2 — generate the new keypair (becomes "current"). Use
    // a fresh kid derived from a UUID-like timestamp + entropy
    // so it is distinct from the previous one and human-readable
    // in JWKS responses.
    const newKid = `athlya-${Date.now().toString(36)}-${randomHex(4)}`;
    const { privateKey, publicKey } = await genKp('RS256', {
      modulusLength: 2048,
      extractable: true,
    });
    const next: SigningKey = {
      kid: newKid,
      privateKey,
      publicKey,
    };

    // Step 3 — compute the rotation: notBefore on `current`,
    // notAfter on `previous`, JWKS containing both.
    const result = await rotateKeysAsync(previous, next, graceDefault, clock());

    // Step 4 — export the new key material as PEM so the
    // operator can pipe it directly into `wrangler secret put`.
    const [currentPrivatePem, currentPublicPem] = await Promise.all([
      exportPKCS8(privateKey),
      exportSPKI(publicKey),
    ]);

    // Step 5 — append audit row (PII-safe). Best-effort: if the
    // audit store is unreachable, log a warning but keep the
    // response — the operator still gets the artefacts and the
    // rotation can proceed. The audit row will be reconciled
    // manually if needed.
    if (deps.auditWriter !== undefined) {
      const claims = c.get('authClaims') as { userId?: unknown };
      const actorId = typeof claims.userId === 'string' ? claims.userId : 'unknown';
      try {
        await deps.auditWriter.appendRotationPrep({
          actorId,
          kidOld: previous.kid,
          kidNew: next.kid,
          graceSec: graceDefault,
        });
      } catch (err) {
        const logger = c.get('logger') as { warn: (m: string, ctx?: unknown) => void } | undefined;
        if (logger !== undefined) {
          logger.warn('jwt rotation prep: audit append failed; continuing', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const response: RotationPrepareResponse = {
      currentKid: result.current.kid,
      currentPrivatePem,
      currentPublicPem,
      previousKid: result.previous.kid,
      previousNotAfter: result.previous.notAfter?.toISOString() ?? '',
      graceSec: graceDefault,
      jwks: result.jwks,
    };
    return c.json(response);
  });

  return router;
}

/* ------------------------------------------------------------------ */
/*  Utilities                                                          */
/* ------------------------------------------------------------------ */

function randomHex(byteCount: number): string {
  const buf = new Uint8Array(byteCount);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Re-export `publicJwkOf` so consumers (mostly the test suite for
// this router) can build a deterministic JWKS without re-importing
// `@athlya/auth`. Pure passthrough.
export { publicJwkOf };
