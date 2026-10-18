/**
 * `/v1/coach/*` router — AI coach (Epic 21, task 21.2).
 *
 *   | Method | Path  | Chain                                                        |
 *   |--------|-------|--------------------------------------------------------------|
 *   | GET    | /     | jwtAuth → studioRateLimit → handler                          |
 *   | POST   | /ask  | jwtAuth → studioRateLimit → zValidator(json) → handler       |
 *
 * Both endpoints sit behind the `ai-coach` feature flag (default OFF),
 * evaluated per user and studio by `deps.isEnabled`. With the flag off,
 * `GET /` answers `{ enabled: false }` so clients hide the coach, and
 * `POST /ask` answers 404 as if the route did not exist.
 *
 * The gateway also applies a per-user burst limiter to `POST /ask`
 * (`base-app.ts`, coverage row `coach-ask`, fail-closed); the daily
 * quota is enforced by the use case and fails closed as well.
 *
 * Error mapping of `CoachError` (`@athlya/ai-coach/errors`):
 *
 *   | code                | HTTP | problem `code`                  |
 *   |---------------------|------|---------------------------------|
 *   | consent_required    | 403  | third_party_consent_required    |
 *   | quota_exceeded      | 429  | coach_quota_exceeded            |
 *   | quota_unavailable   | 503  | dependency_unavailable          |
 *   | not_configured      | 503  | coach_not_configured            |
 *   | upstream_failed     | 502  | coach_upstream_failed           |
 *   | invalid_output      | 502  | coach_invalid_output            |
 *
 * Responses carry `Cache-Control: no-store`: the advice is personal
 * and is not stored anywhere, the browser included.
 */

import { isCoachError } from '@athlya/ai-coach/errors';
import { CoachAskRequestSchema } from '@athlya/shared/schemas/api';
import { Hono } from 'hono';

import { jwtAuth } from '../middleware/auth.js';
import { studioRateLimit } from '../middleware/studio-rate-limit.js';
import { zValidator } from '../middleware/validator.js';

import { readValidated, traceOperation } from './helpers.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { HonoEnv } from '../types.js';
import type { CoachErrorCode } from '@athlya/ai-coach/errors';
import type {
  CoachAskRequest,
  CoachAskResponse,
  CoachStatusResponse,
} from '@athlya/shared/schemas/api';
import type { Context } from 'hono';

/** Dependencies injected into {@link buildCoachRouter}. */
export interface CoachDeps {
  /** `ai-coach` feature flag for the caller. */
  isEnabled(claims: AuthClaims): Promise<boolean>;
  /** Consent and quota of the caller; only called when the flag is on. */
  getStatus(claims: AuthClaims): Promise<CoachStatusResponse>;
  /** Ask the coach; only called when the flag is on. Throws `CoachError`. */
  ask(claims: AuthClaims, request: CoachAskRequest): Promise<CoachAskResponse>;
}

const PROBLEM_JSON = 'application/problem+json';
const NO_STORE = 'no-store';

/** Seconds a client should wait after a dependency outage (limiter guard parity). */
const DEPENDENCY_RETRY_AFTER_SEC = 30;

interface CoachProblem {
  readonly status: 403 | 404 | 429 | 502 | 503;
  readonly title: string;
  readonly code: string;
  readonly detail: string;
}

const COACH_PROBLEMS: Record<CoachErrorCode, CoachProblem> = {
  consent_required: {
    status: 403,
    title: 'Forbidden',
    code: 'third_party_consent_required',
    detail: 'The AI coach needs your consent to share training data with third parties',
  },
  quota_exceeded: {
    status: 429,
    title: 'Too Many Requests',
    code: 'coach_quota_exceeded',
    detail: 'Daily AI coach quota reached',
  },
  quota_unavailable: {
    status: 503,
    title: 'Service Unavailable',
    code: 'dependency_unavailable',
    detail: 'Rate limiting dependency is temporarily unavailable',
  },
  not_configured: {
    status: 503,
    title: 'Service Unavailable',
    code: 'coach_not_configured',
    detail: 'The AI coach is not configured for this environment',
  },
  upstream_failed: {
    status: 502,
    title: 'Bad Gateway',
    code: 'coach_upstream_failed',
    detail: 'The AI coach provider did not answer',
  },
  invalid_output: {
    status: 502,
    title: 'Bad Gateway',
    code: 'coach_invalid_output',
    detail: 'The AI coach provider returned an invalid answer',
  },
};

const DISABLED: CoachProblem = {
  status: 404,
  title: 'Not Found',
  code: 'coach_disabled',
  detail: 'The AI coach is not available',
};

function problem(c: Context<HonoEnv>, p: CoachProblem, retryAfterSec?: number): Response {
  const headers: Record<string, string> = {
    'content-type': PROBLEM_JSON,
    'cache-control': NO_STORE,
  };
  if (retryAfterSec !== undefined) {
    headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfterSec)));
  }
  return c.body(
    JSON.stringify({
      type: 'about:blank',
      title: p.title,
      status: p.status,
      detail: p.detail,
      code: p.code,
      traceId: c.get('traceId'),
    }),
    p.status,
    headers,
  );
}

function claimsOf(c: Context<HonoEnv>): AuthClaims {
  const claims = c.get('authClaims');
  if (claims === undefined) {
    throw new Error('authClaims unexpectedly missing after jwtAuth');
  }
  return claims;
}

/** Build the `/v1/coach/*` sub-router. */
export function buildCoachRouter(deps: CoachDeps): Hono<HonoEnv> {
  const router = new Hono<HonoEnv>();

  router.use('*', jwtAuth());
  router.use('*', studioRateLimit() as Parameters<typeof router.use>[1]);

  router.get('/', async (c) => {
    traceOperation(c, 'coach.status');
    const claims = claimsOf(c);
    c.header('cache-control', NO_STORE);
    if (!(await deps.isEnabled(claims))) {
      return c.json({ enabled: false } satisfies CoachStatusResponse, 200);
    }
    try {
      return c.json(await deps.getStatus(claims), 200);
    } catch (err) {
      if (isCoachError(err)) {
        const p = COACH_PROBLEMS[err.code];
        return problem(c, p, p.status === 503 ? DEPENDENCY_RETRY_AFTER_SEC : undefined);
      }
      throw err;
    }
  });

  router.post('/ask', zValidator('json', CoachAskRequestSchema), async (c) => {
    traceOperation(c, 'coach.ask');
    const claims = claimsOf(c);
    if (!(await deps.isEnabled(claims))) {
      return problem(c, DISABLED);
    }
    const request = readValidated<CoachAskRequest>(c, 'json');
    try {
      const answer = await deps.ask(claims, request);
      c.header('cache-control', NO_STORE);
      return c.json(answer, 200);
    } catch (err) {
      if (!isCoachError(err)) throw err;
      const p = COACH_PROBLEMS[err.code];
      const retryAfter =
        err.code === 'quota_exceeded'
          ? err.retryAfterSec
          : p.status === 503
            ? DEPENDENCY_RETRY_AFTER_SEC
            : undefined;
      if (p.status >= 500) {
        c.get('logger').warn('coach request failed', {
          code: err.code,
          cause: err.cause instanceof Error ? err.cause.name : undefined,
        });
      }
      return problem(c, p, retryAfter);
    }
  });

  return router;
}
