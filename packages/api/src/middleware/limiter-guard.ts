/**
 * Shared fail-open / fail-closed policy for Redis-backed limiters.
 *
 * Issue #65 — mutations critiques renvoient 503 si Upstash est
 * indisponible ; les reads (global IP limiter) restent fail-open.
 */

import type { RateLimitMiddleware } from './rate-limit.js';

const PROBLEM_JSON = 'application/problem+json';

export type LimiterFailPolicy = 'fail-open' | 'fail-closed';

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
      logger.warn('rate-limit unavailable', {
        scope,
        policy,
        error: err instanceof Error ? err.message : String(err),
      });

      if (policy === 'fail-closed') {
        return buildDependencyUnavailableResponse(traceId);
      }

      await next();
      return undefined;
    }
  };
}
