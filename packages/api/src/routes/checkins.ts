/**
 * `/v1/checkins/*` domain router — task 8.11, issue #654 (part of #648).
 *
 * Endpoints and their middleware chains:
 *
 *   | Method | Path   | Chain                                                                                         |
 *   |--------|--------|-----------------------------------------------------------------------------------------------|
 *   | POST   | /token | jwtAuth → studioRateLimit → tokenRateLimit → handler                                          |
 *   | POST   | /      | jwtAuth → studioRateLimit → requireCapability('checkin.kiosk') → checkinRateLimit → zValidator → idempotency → handler |
 *
 * Requirements:
 *   • 11.1 — `POST /token` issues the member's `QR_Checkin_Token`
 *            (RS256, `kind = 'checkin'`, `exp = iat + 120 s`, fresh
 *            `jti`). Signing needs the server private key, so the
 *            Mobile_App fetches it here and renders it as a QR code.
 *   • 11.2–11.6 — `POST /` is the kiosk scan (task 12.4): staff
 *            present the member's token. The service verifies it
 *            before any database read; each token failure maps to a
 *            401 whose `code` names the reason (`invalid_signature`,
 *            `token_expired`, `replay`, `wrong_studio`, `wrong_kind`,
 *            `malformed`); a valid token without a reservation in the
 *            window maps to 422.
 *   • 14.1, 14.2, 20.1 — auth / validation / idempotency (bound per
 *            request to the operator's claims).
 *
 * Only admins and coaches may check a member in: the token proves who
 * the member is, the operator's session proves the member is at the
 * desk. A member posting their own token gets 403.
 */

import { CheckInRequestSchema } from '@athlya/shared/schemas/api';
import { Hono } from 'hono';

import { jwtAuth } from '../middleware/auth.js';
import { guardRateLimiter } from '../middleware/limiter-guard.js';
import { CHECKIN_BUDGET, CHECKIN_TOKEN_BUDGET } from '../middleware/rate-limit-policies.js';
import {
  MUTATION_IP_BUCKET_PREFIX,
  MUTATION_USER_BUCKET_PREFIX,
  rateLimit,
} from '../middleware/rate-limit.js';
import { applySecurityHeaders, buildSecurityHeaders } from '../middleware/security-headers.js';
import { studioRateLimit } from '../middleware/studio-rate-limit.js';
import { zValidator } from '../middleware/validator.js';

import {
  idempotency,
  projectUserIdFromClaims,
  readValidated,
  requireCapability,
  traceOperation,
} from './helpers.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { IdempotencyMiddlewareDeps } from '../middleware/idempotency.js';
import type { RateLimitBudget } from '../middleware/rate-limit-policies.js';
import type { RateLimitOptions } from '../middleware/rate-limit.js';
import type { HonoEnv } from '../types.js';
import type {
  CheckInRequest,
  CheckInResponse,
  CheckInTokenResponse,
} from '@athlya/shared/schemas/api';
import type { Context, MiddlewareHandler } from 'hono';

/* ------------------------------------------------------------------ */
/*  Outcome                                                            */
/* ------------------------------------------------------------------ */

/**
 * Fine-grained failure reasons surfaced by the check-in service.
 * Matches `QRVerifyFailReason` from `@athlya/reservations/checkin`
 * plus the post-verification failure modes.
 */
export type CheckInFailReason =
  | 'invalid_signature'
  | 'token_expired'
  | 'replay'
  | 'wrong_studio'
  | 'wrong_kind'
  | 'malformed'
  | 'outside_window'
  | 'no_reservation'
  | 'already_checked_in'
  | 'checkin_limit_reached';

/** Discriminated result returned by {@link CheckinsDeps.checkIn}. */
export type CheckInOutcome =
  | {
      readonly kind: 'success';
      readonly reservationId: CheckInResponse['reservationId'];
      readonly member: CheckInResponse['member'];
    }
  | { readonly kind: 'fail'; readonly reason: CheckInFailReason };

/** Dependencies injected into {@link buildCheckinsRouter}. */
export interface CheckinsDeps {
  /** Issue a `QR_Checkin_Token` for the caller (Requirement 11.1). */
  issueToken(claims: AuthClaims): Promise<CheckInTokenResponse>;
  /** Check in the member named by the token, at the operator's studio. */
  checkIn(operator: AuthClaims, input: CheckInRequest): Promise<CheckInOutcome>;
  /**
   * Idempotency store bound to the caller's tenant claims, or
   * `undefined` when the environment has none.
   */
  idempotencyFor?(claims: AuthClaims): IdempotencyMiddlewareDeps | undefined;
  /** Redis options forwarded to the per-user rate limiters. Inject a fake in tests. */
  readonly rateLimitOpts?: RateLimitOptions;
}

/* ------------------------------------------------------------------ */
/*  Problem Details                                                    */
/* ------------------------------------------------------------------ */

/**
 * Reasons that surface as HTTP 401 per Requirement 11.3. The others
 * surface as 422 (the token was valid but the reservation state
 * rejected the check-in), except `checkin_limit_reached`: 429, the
 * member was already checked in 5 times in the last hour (#338).
 */
const TOKEN_FAILURE_REASONS = new Set<CheckInFailReason>([
  'invalid_signature',
  'token_expired',
  'replay',
  'wrong_studio',
  'wrong_kind',
  'malformed',
]);

const TITLES = { 401: 'Unauthorized', 422: 'Unprocessable Entity', 429: 'Too Many Requests' };

/** Seconds a member waits after `checkin_limit_reached` (the bound is per hour). */
const MEMBER_LIMIT_RETRY_AFTER_SEC = 3600;

function problemCheckinFail(c: Context<HonoEnv>, reason: CheckInFailReason): Response {
  const status: 401 | 422 | 429 =
    reason === 'checkin_limit_reached' ? 429 : TOKEN_FAILURE_REASONS.has(reason) ? 401 : 422;
  const title = TITLES[status];
  return c.body(
    JSON.stringify({
      type: 'about:blank',
      title,
      status,
      detail: `check-in rejected: ${reason}`,
      code: reason,
      traceId: c.get('traceId'),
    }),
    status,
    {
      'content-type': 'application/problem+json',
      ...(status === 429 ? { 'retry-after': String(MEMBER_LIMIT_RETRY_AFTER_SEC) } : {}),
    },
  );
}

function claimsOf(c: Context<HonoEnv>): AuthClaims {
  const claims = c.get('authClaims');
  if (claims === undefined) {
    throw new Error('authClaims unexpectedly missing after jwtAuth');
  }
  return claims;
}

/* ------------------------------------------------------------------ */
/*  Rate limits                                                        */
/* ------------------------------------------------------------------ */

const SECURITY_HEADERS: Readonly<Record<string, string>> = buildSecurityHeaders();

/**
 * Per-user limiter running after `jwtAuth` (keyed on
 * `rl:user:mutation-<scope>:<userId>`), fail-closed: a Redis outage
 * answers 503. `dev` is exempt like every gateway limiter.
 */
function perUserLimit(
  scope: string,
  budget: RateLimitBudget,
  opts: RateLimitOptions | undefined,
): MiddlewareHandler<HonoEnv> {
  const guarded = guardRateLimiter(
    'mutation',
    rateLimit({
      ...budget,
      keyPrefix: `${MUTATION_IP_BUCKET_PREFIX}-${scope}`,
      userKeyPrefix: `${MUTATION_USER_BUCKET_PREFIX}-${scope}`,
      ...opts,
    }),
    'fail-closed',
    false,
  );
  return async (c, next) => {
    if (c.env.ENVIRONMENT === 'dev') {
      await next();
      return;
    }
    const result = await (
      guarded as unknown as (
        ctx: Context<HonoEnv>,
        n: () => Promise<void>,
      ) => Promise<Response | undefined>
    )(c, next);
    return result instanceof Response ? applySecurityHeaders(result, SECURITY_HEADERS) : undefined;
  };
}

/**
 * The per-operator check-in limiter (`CHECKIN_BUDGET`). The kiosk scan
 * and the manual check-in from a class roster share its bucket, so an
 * operator has one check-in rate whichever way they mark members present.
 */
export function checkinOperatorLimit(opts?: RateLimitOptions): MiddlewareHandler<HonoEnv> {
  return perUserLimit('checkin', CHECKIN_BUDGET, opts);
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/** Build the `/v1/checkins/*` sub-router. */
export function buildCheckinsRouter(deps: CheckinsDeps): Hono<HonoEnv> {
  const router = new Hono<HonoEnv>();

  /** Idempotency bound per request to the operator's tenant claims. */
  const idem: MiddlewareHandler<HonoEnv> = async (c, next) => {
    const store = deps.idempotencyFor?.(claimsOf(c));
    if (store === undefined) {
      await next();
      return;
    }
    return idempotency(store)(c, next);
  };

  router.use('*', jwtAuth());

  // Sprint 12 / Slice 12.14 (Epic B4.4) — per-studio burst cap.
  router.use('*', studioRateLimit() as Parameters<typeof router.use>[1]);

  /* ------------------------------ POST /token -------------------- */
  router.post(
    '/token',
    perUserLimit('checkin-token', CHECKIN_TOKEN_BUDGET, deps.rateLimitOpts),
    async (c) => {
      traceOperation(c, 'checkins.issue-token');
      const issued = await deps.issueToken(claimsOf(c));
      return c.json(issued, 201, { 'cache-control': 'no-store' });
    },
  );

  /* ------------------------------ POST / ------------------------- */
  router.post(
    '/',
    requireCapability('checkin.kiosk'),
    checkinOperatorLimit(deps.rateLimitOpts),
    projectUserIdFromClaims(),
    zValidator('json', CheckInRequestSchema),
    idem,
    async (c) => {
      traceOperation(c, 'checkins.check-in');
      const body = readValidated<CheckInRequest>(c, 'json');
      const outcome = await deps.checkIn(claimsOf(c), body);

      if (outcome.kind === 'success') {
        const response: CheckInResponse = {
          success: true,
          reservationId: outcome.reservationId,
          member: outcome.member,
        };
        return c.json(response, 200);
      }
      return problemCheckinFail(c, outcome.reason);
    },
  );

  return router;
}
