import { describe, expect, it, vi } from 'vitest';

import {
  buildDependencyUnavailableResponse,
  buildRateLimitDependencyDeniedResponse,
  guardRateLimiter,
} from '../middleware/limiter-guard.js';
import { rateLimit, type RateLimitContext } from '../middleware/rate-limit.js';

function fakeContext(): RateLimitContext & { header: ReturnType<typeof vi.fn> } {
  return {
    env: {
      REDIS_URL: 'https://example.upstash.io',
      REDIS_TOKEN: 'test-token',
    },
    req: { header: () => undefined },
    get(key: string): unknown {
      if (key === 'traceId') return 'trace-65';
      return undefined;
    },
    header: vi.fn(),
  };
}

describe('buildDependencyUnavailableResponse', () => {
  it('returns 503 Problem Details with dependency_unavailable', async () => {
    const res = buildDependencyUnavailableResponse('trace-65');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    const body = (await res.json()) as { status: number; code: string; traceId: string };
    expect(body.status).toBe(503);
    expect(body.code).toBe('dependency_unavailable');
    expect(body.traceId).toBe('trace-65');
  });
});

describe('buildRateLimitDependencyDeniedResponse', () => {
  it('returns 429 Problem Details with retry-after', async () => {
    const res = buildRateLimitDependencyDeniedResponse('trace-128', 60);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    const body = (await res.json()) as { status: number; code: string; traceId: string };
    expect(body.status).toBe(429);
    expect(body.code).toBe('rate_limit_dependency_unavailable');
    expect(body.traceId).toBe('trace-128');
  });
});

describe('guardRateLimiter', () => {
  it('fail-closed returns 503 when inner limiter throws before next', async () => {
    const inner = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as ReturnType<typeof rateLimit>;

    const guarded = guardRateLimiter('auth', inner, 'fail-closed', false);
    const next = vi.fn();
    const result = await guarded(fakeContext(), next);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('fail-closed-soft returns 429 when inner limiter throws before next', async () => {
    const inner = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as ReturnType<typeof rateLimit>;

    const guarded = guardRateLimiter('global', inner, 'fail-closed-soft', false);
    const next = vi.fn();
    const result = await guarded(fakeContext(), next);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(429);
    expect(next).not.toHaveBeenCalled();
  });

  it('fail-open proceeds when inner limiter throws before next', async () => {
    const inner = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as ReturnType<typeof rateLimit>;

    const guarded = guardRateLimiter('global', inner, 'fail-open', false);
    const next = vi.fn();
    const result = await guarded(fakeContext(), next);

    expect(result).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});
