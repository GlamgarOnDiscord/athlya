/**
 * `/v1/coach/*` router — AI coach (Epic 21, task 21.2).
 *
 *   | Method | Path  | Chain                                                        |
 *   |--------|-------|--------------------------------------------------------------|
 *   | GET    | /     | jwtAuth → studioRateLimit → handler                          |
 *   | POST   | /ask  | jwtAuth → studioRateLimit → flag → burst limit →             |
 *   |        |       | zValidator(json) → handler                                   |
 *
 * Both endpoints sit behind the `ai-coach` feature flag (default OFF),
 * evaluated per user and studio by `deps.isEnabled`. With the flag off,
 * `GET /` answers `{ enabled: false }` so clients hide the coach, and
 * `POST /ask` answers 404 as if the route did not exist: the flag runs
 * before the burst limiter and the body validation, so a disabled coach
 * never answers 422, 429 or a limiter 503.
 *
 * The burst limiter (coverage row `coach-ask`: 5/min per user, keyed on
 * the JWT user, fail-closed 503 when Redis is down, bypassed in `dev`)
 * is mounted here rather than in `base-app.ts` so it only runs for
 * members who have the coach. The daily quota is enforced by the use
 * case and fails closed as well.
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
 * Streaming (task 21.2). With `Accept: text/event-stream`, `POST /ask`
 * answers through Hono's `streamSSE` once consent, quota and context are
 * done, so every refusal above keeps its status and problem body.
 * Events, each `data` one JSON document:
 *
 *   - `partial` — `CoachAdvicePartial` snapshot, zero or more, at most
 *                 one per 150 ms (`COACH_PARTIAL_INTERVAL_MS`).
 *   - `done`    — `CoachAskResponse`, validated as before. Terminal.
 *   - `error`   — problem body (`coach_upstream_failed`,
 *                 `coach_invalid_output`, `internal_error`). Terminal.
 *
 * A partial is provisional (clipped to the schema bounds, not validated
 * as a whole); after an `error` event the client discards it. A client
 * disconnect aborts the provider call. Without that `Accept` value the
 * JSON response is unchanged.
 *
 * Responses carry `Cache-Control: no-store`: the advice is personal
 * and is not stored anywhere, the browser included.
 */

import { isCoachError } from '@athlya/ai-coach/errors';
import { CoachAskRequestSchema } from '@athlya/shared/schemas/api';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { jwtAuth } from '../middleware/auth.js';
import { guardRateLimiter } from '../middleware/limiter-guard.js';
import { MUTATION_BUDGETS } from '../middleware/rate-limit-policies.js';
import {
  MUTATION_IP_BUCKET_PREFIX,
  MUTATION_USER_BUCKET_PREFIX,
  rateLimit,
} from '../middleware/rate-limit.js';
import { applySecurityHeaders, buildSecurityHeaders } from '../middleware/security-headers.js';
import { studioRateLimit } from '../middleware/studio-rate-limit.js';
import { zValidator } from '../middleware/validator.js';

import { readValidated, traceOperation } from './helpers.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { HonoEnv } from '../types.js';
import type { CoachErrorCode } from '@athlya/ai-coach/errors';
import type {
  CoachAdvicePartial,
  CoachAskRequest,
  CoachAskResponse,
  CoachStatusResponse,
  CoachStreamEvent,
} from '@athlya/shared/schemas/api';
import type { Context, MiddlewareHandler } from 'hono';

/** Dependencies injected into {@link buildCoachRouter}. */
export interface CoachDeps {
  /** `ai-coach` feature flag for the caller. */
  isEnabled(claims: AuthClaims): Promise<boolean>;
  /** Consent and quota of the caller; only called when the flag is on. */
  getStatus(claims: AuthClaims): Promise<CoachStatusResponse>;
  /** Ask the coach; only called when the flag is on. Throws `CoachError`. */
  ask(claims: AuthClaims, request: CoachAskRequest): Promise<CoachAskResponse>;
  /**
   * Streaming `ask`: settles once every pre-model check passed (or throws
   * `CoachError`), then yields partial snapshots and returns the validated
   * answer; the iteration throws `CoachError` on a provider failure.
   * `signal` aborts the provider call.
   */
  askStream(
    claims: AuthClaims,
    request: CoachAskRequest,
    signal: AbortSignal,
  ): Promise<AsyncGenerator<CoachAdvicePartial, CoachAskResponse, undefined>>;
}

const PROBLEM_JSON = 'application/problem+json';
const NO_STORE = 'no-store';

/** Seconds a client should wait after a dependency outage (limiter guard parity). */
const DEPENDENCY_RETRY_AFTER_SEC = 30;

interface CoachProblem {
  readonly status: 403 | 404 | 429 | 500 | 502 | 503;
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

const RATE_LIMITED: CoachProblem = {
  status: 429,
  title: 'Too Many Requests',
  code: 'coach_rate_limited',
  detail: 'Too many AI coach requests in a short time',
};

const DISABLED: CoachProblem = {
  status: 404,
  title: 'Not Found',
  code: 'coach_disabled',
  detail: 'The AI coach is not available',
};

const STREAM_FAILED: CoachProblem = {
  status: 500,
  title: 'Internal Server Error',
  code: 'internal_error',
  detail: 'The AI coach answer failed',
};

function problemBody(c: Context<HonoEnv>, p: CoachProblem): string {
  return JSON.stringify({
    type: 'about:blank',
    title: p.title,
    status: p.status,
    detail: p.detail,
    code: p.code,
    traceId: c.get('traceId'),
  });
}

function problem(c: Context<HonoEnv>, p: CoachProblem, retryAfterSec?: number): Response {
  const headers: Record<string, string> = {
    'content-type': PROBLEM_JSON,
    'cache-control': NO_STORE,
  };
  if (retryAfterSec !== undefined) {
    headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfterSec)));
  }
  return c.body(problemBody(c, p), p.status, headers);
}

/** Map a `CoachError` to its problem response; 5xx are logged (code and cause class only). */
function coachProblem(
  c: Context<HonoEnv>,
  code: CoachErrorCode,
  retryAfterSec: number | undefined,
  cause: unknown,
): Response {
  const p = COACH_PROBLEMS[code];
  if (p.status >= 500) {
    c.get('logger').warn('coach request failed', {
      code,
      cause: cause instanceof Error ? cause.name : undefined,
    });
  }
  const retryAfter =
    code === 'quota_exceeded'
      ? retryAfterSec
      : p.status === 503
        ? DEPENDENCY_RETRY_AFTER_SEC
        : undefined;
  return problem(c, p, retryAfter);
}

/**
 * True when `Accept` lists `text/event-stream` explicitly with a non-zero
 * quality. Wildcard ranges (any type, `text` subtypes) keep the JSON answer.
 */
export function wantsEventStream(accept: string | undefined): boolean {
  if (accept === undefined) return false;
  return accept.split(',').some((range) => {
    const [type, ...params] = range.split(';').map((part) => part.trim().toLowerCase());
    if (type !== 'text/event-stream') return false;
    const q = params.find((param) => param.startsWith('q='));
    return q === undefined || Number.parseFloat(q.slice(2)) > 0;
  });
}

/** Problem of an error raised once the stream is open; 5xx are logged like {@link coachProblem}. */
function streamProblem(c: Context<HonoEnv>, err: unknown): CoachProblem {
  if (isCoachError(err)) {
    const p = COACH_PROBLEMS[err.code];
    c.get('logger').warn('coach stream failed', {
      code: err.code,
      cause: err.cause instanceof Error ? err.cause.name : undefined,
    });
    return p;
  }
  c.get('logger').error('coach stream failed', {
    cause: err instanceof Error ? err.name : typeof err,
  });
  return STREAM_FAILED;
}

/**
 * Stream the answer as server-sent events. Every error is written as an
 * `error` event here: `streamSSE`'s own handler would send the raw
 * error message.
 */
async function streamAnswer(
  c: Context<HonoEnv>,
  deps: CoachDeps,
  claims: AuthClaims,
  request: CoachAskRequest,
): Promise<Response> {
  const controller = new AbortController();
  let events: AsyncGenerator<CoachAdvicePartial, CoachAskResponse, undefined>;
  try {
    events = await deps.askStream(claims, request, controller.signal);
  } catch (err) {
    if (!isCoachError(err)) throw err;
    return coachProblem(c, err.code, err.retryAfterSec, err.cause);
  }

  const response = streamSSE(c, async (stream) => {
    stream.onAbort(() => {
      controller.abort();
    });
    const write = (event: CoachStreamEvent, data: string): Promise<void> =>
      stream.writeSSE({ event, data });
    try {
      for (;;) {
        const step = await events.next();
        if (step.done === true) {
          await write('done', JSON.stringify(step.value));
          return;
        }
        await write('partial', JSON.stringify(step.value));
      }
    } catch (err) {
      controller.abort();
      if (stream.aborted) return;
      try {
        await write('error', problemBody(c, streamProblem(c, err)));
      } catch {
        // The client is gone; nothing left to tell it.
      }
    }
  });
  // `streamSSE` sets `no-cache` on the context, whose headers Hono copies
  // onto the response; the advice must not be stored at all.
  c.header('cache-control', NO_STORE);
  return response;
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = buildSecurityHeaders();

/**
 * Per-user burst limiter of `POST /ask` (`MUTATION_BUDGETS.coach`). Runs
 * after `jwtAuth`, so it keys on `rl:user:mutation-coach:<userId>`.
 */
function coachBurstLimit(): MiddlewareHandler<HonoEnv> {
  const guarded = guardRateLimiter(
    'mutation',
    rateLimit({
      ...MUTATION_BUDGETS.coach,
      keyPrefix: `${MUTATION_IP_BUCKET_PREFIX}-coach`,
      userKeyPrefix: `${MUTATION_USER_BUCKET_PREFIX}-coach`,
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
    if (result instanceof Response) {
      if (result.status !== 429) return applySecurityHeaders(result, SECURITY_HEADERS);
      // Give the generic limiter deny a coach code clients can branch on.
      const retryAfter = Number.parseInt(result.headers.get('retry-after') ?? '', 10);
      return applySecurityHeaders(
        problem(c, RATE_LIMITED, Number.isFinite(retryAfter) ? retryAfter : 60),
        SECURITY_HEADERS,
      );
    }
    return;
  };
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
      if (!isCoachError(err)) throw err;
      return coachProblem(c, err.code, err.retryAfterSec, err.cause);
    }
  });

  const requireEnabled: MiddlewareHandler<HonoEnv> = async (c, next) => {
    if (!(await deps.isEnabled(claimsOf(c)))) {
      return problem(c, DISABLED);
    }
    await next();
    return;
  };

  router.post(
    '/ask',
    requireEnabled,
    coachBurstLimit(),
    zValidator('json', CoachAskRequestSchema),
    async (c) => {
      traceOperation(c, 'coach.ask');
      const claims = claimsOf(c);
      const request = readValidated<CoachAskRequest>(c, 'json');
      // The body depends on `Accept` (JSON or event stream).
      c.header('vary', 'Accept', { append: true });
      if (wantsEventStream(c.req.header('accept'))) {
        return streamAnswer(c, deps, claims, request);
      }
      try {
        const answer = await deps.ask(claims, request);
        c.header('cache-control', NO_STORE);
        return c.json(answer, 200);
      } catch (err) {
        if (!isCoachError(err)) throw err;
        return coachProblem(c, err.code, err.retryAfterSec, err.cause);
      }
    },
  );

  return router;
}
