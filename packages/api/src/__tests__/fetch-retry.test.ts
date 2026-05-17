/**
 * Unit tests for the `fetch-retry` helper (Sprint 12 / Slice 12.1).
 *
 * Mirrors the test pattern of `packages/auth/src/__tests__/hibp.test.ts`
 * — inject a deterministic `fetch` mock and assert call counts +
 * outcomes. Tests run with `retries: 0` or `retries: 2` explicitly
 * so the suite stays fast (no real backoff sleeps when not relevant).
 */

import { describe, expect, it, vi } from 'vitest';

import { FetchRetryExhaustedError, fetchWithRetry } from '../adapters/fetch-retry.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function okResponse(body: string = 'ok'): Response {
  return new Response(body, { status: 200 });
}

function statusResponse(status: number, body: string = ''): Response {
  return new Response(body, { status });
}

/* ------------------------------------------------------------------ */
/*  Happy path                                                         */
/* ------------------------------------------------------------------ */

describe('fetchWithRetry — happy path', () => {
  it('returns the response on first-attempt success', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse()));

    const res = await fetchWithRetry('https://api.example/foo', {}, { fetch: fetchMock });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns 4xx (non-429) response on first attempt without retry', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(statusResponse(400)));

    const res = await fetchWithRetry(
      'https://api.example/foo',
      {},
      { fetch: fetchMock, retries: 5 },
    );

    // 400 is non-retryable — surface to the caller.
    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns 3xx response on first attempt without retry', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(statusResponse(301)));

    const res = await fetchWithRetry(
      'https://api.example/foo',
      {},
      { fetch: fetchMock, retries: 5 },
    );

    expect(res.status).toBe(301);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/*  Retry on 5xx / 429                                                  */
/* ------------------------------------------------------------------ */

describe('fetchWithRetry — retries on transient failures', () => {
  it('retries on 503 and succeeds on the second attempt', async () => {
    let calls = 0;
    const fetchMock = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(statusResponse(503));
      }
      return Promise.resolve(okResponse());
    });

    const res = await fetchWithRetry(
      'https://api.example/foo',
      {},
      { fetch: fetchMock, retries: 2 },
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 and succeeds on the second attempt', async () => {
    let calls = 0;
    const fetchMock = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(statusResponse(429));
      }
      return Promise.resolve(okResponse());
    });

    const res = await fetchWithRetry(
      'https://api.example/foo',
      {},
      { fetch: fetchMock, retries: 2 },
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on network failure and succeeds on the third attempt', async () => {
    let calls = 0;
    const fetchMock = vi.fn(() => {
      calls += 1;
      if (calls < 3) {
        return Promise.reject(new Error('ECONNRESET'));
      }
      return Promise.resolve(okResponse());
    });

    const res = await fetchWithRetry(
      'https://api.example/foo',
      {},
      { fetch: fetchMock, retries: 2 },
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

/* ------------------------------------------------------------------ */
/*  Exhaustion                                                         */
/* ------------------------------------------------------------------ */

describe('fetchWithRetry — exhaustion', () => {
  it('throws FetchRetryExhaustedError after all attempts fail with 5xx', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(statusResponse(500)));

    await expect(
      fetchWithRetry('https://api.example/foo', {}, { fetch: fetchMock, retries: 2 }),
    ).rejects.toBeInstanceOf(FetchRetryExhaustedError);

    // 1 initial + 2 retries = 3 total.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws FetchRetryExhaustedError after all attempts fail with network error', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('connection refused')));

    await expect(
      fetchWithRetry('https://api.example/foo', {}, { fetch: fetchMock, retries: 2 }),
    ).rejects.toBeInstanceOf(FetchRetryExhaustedError);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('preserves the last underlying error on the cause chain', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('boom: ETIMEDOUT')));

    try {
      await fetchWithRetry('https://api.example/foo', {}, { fetch: fetchMock, retries: 1 });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FetchRetryExhaustedError);
      const exhausted = err as FetchRetryExhaustedError;
      expect(exhausted.attempts).toBe(2);
      expect(exhausted.message).toContain('failed after 2 attempt(s)');
      expect(exhausted.message).toContain('boom: ETIMEDOUT');
      // `cause` carries the last underlying error verbatim so
      // logging surfaces the full chain.
      const cause = (exhausted as { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).message).toBe('boom: ETIMEDOUT');
    }
  });
});

/* ------------------------------------------------------------------ */
/*  retries: 0                                                          */
/* ------------------------------------------------------------------ */

describe('fetchWithRetry — retries: 0 disables the loop', () => {
  it('makes a single attempt then throws on a transient failure', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(statusResponse(503)));

    await expect(
      fetchWithRetry('https://api.example/foo', {}, { fetch: fetchMock, retries: 0 }),
    ).rejects.toBeInstanceOf(FetchRetryExhaustedError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
