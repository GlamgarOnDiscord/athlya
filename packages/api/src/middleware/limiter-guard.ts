/**
 * Shared fail-open / fail-closed policy for Redis-backed limiters.
 *
 * Issue #65 — mutations critiques renvoient 503 si Upstash est
 * indisponible.
 * Issue #128 — le limiter global IP (`/v1/*`) renvoie 429
 * (`fail-closed-soft`) si Upstash throw avant `next()` ; `/health`
 * reste hors scope car non monté sous `/v1/*`.
 */

import { DEFAULT_WINDOW_SEC } from './rate-limit.js';

import type { RateLimitMiddleware } from './rate-limit.js';

const PROBLEM_JSON = 'application/problem+json';

export type LimiterFailPolicy = 'fail-open' | 'fail-closed' | 'fail-closed-soft';

export function buildDependencyUnavailableResponse(traceId: string): Response {
  const body = JSON.stringify({
    type: 'about:blank',
    title: 'Service Unavailable',
    status: 503,
    code: 'dependency_unavailable',
    detail: 'Rate limiting dependency is temporarily unavailable',
    traceId,
  });

  return new Response(body, {
    status: 503,
    headers: {
      'content-type': PROBLEM_JSON,
      'retry-after': '30',
    },
  });
}

/** Synthetic 429 when the limiter dependency is down (global reads, issue #128). */
export function buildRateLimitDependencyDeniedResponse(
  traceId: string,
  retryAfterSec: number = DEFAULT_WINDOW_SEC,
): Response {
  const retryAfter = Math.max(1, Math.floor(retryAfterSec));
  const body = JSON.stringify({
    type: 'about:blank',
    title: 'Too Many Requests',
    status: 429,
    code: 'rate_limit_dependency_unavailable',
    detail: 'Rate limiting dependency is temporarily unavailable',
    traceId,
  });

  return new Response(body, {
    status: 429,
    headers: {
      'content-type': PROBLEM_JSON,
      'retry-after': String(retryAfter),
    },
  });
}

function readTraceId(c: { get(key: string): unknown }): string {
  const raw = c.get('traceId');
  return typeof raw === 'string' && raw.length > 0 ? raw : 'unknown';
}

type LoggerLike = { warn: (...args: unknown[]) => void };

function readLogger(c: { get: (key: string) => unknown }): LoggerLike {
  const raw = c.get('logger');
  if (raw !== null && typeof raw === 'object' && typeof (raw as LoggerLike).warn === 'function') {
    return raw as LoggerLike;
  }
  return { warn: () => undefined };
}

/**
 * Wrap a rate-limit middleware with dev bypass and a configurable
 * Redis outage policy.
 */
export function guardRateLimiter(
  scope: string,
  inner: RateLimitMiddleware,
  policy: LimiterFailPolicy,
  isDev: boolean,
): RateLimitMiddleware {
  return async (c, next) => {
    if (isDev) {
      await next();
      return undefined;
    }

    let nextCalled = false;
    const wrappedNext = async () => {
      nextCalled = true;
      await next();
    };

    try {
      const result = await inner(c, wrappedNext);
      if (result instanceof Response) return result;
      return undefined;
    } catch (err) {
      if (nextCalled) {
        throw err;
      }

      const traceId = readTraceId(c);
      const logger = readLogger(c);
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn('athlya.ratelimit.redis_errors', {
        metric: 'ratelimit_redis_errors',
        scope,
        policy,
        error: errMsg,
      });
      logger.warn('rate-limit unavailable', {
        scope,
        policy,
        outcome: policy === 'fail-closed-soft' ? 'dependency_denied' : policy,
        error: errMsg,
      });

      if (policy === 'fail-closed') {
        return buildDependencyUnavailableResponse(traceId);
      }

      if (policy === 'fail-closed-soft') {
        return buildRateLimitDependencyDeniedResponse(traceId);
      }

      await next();
      return undefined;
    }
  };
}
