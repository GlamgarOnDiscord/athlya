/**
 * Unit tests for the web app's API client.
 *
 * Eight cases cover the contract:
 *  1. GET returns the parsed JSON body on 2xx.
 *  2. POST sends the serialised body with `Content-Type: application/json`.
 *  3. Authorization header is attached when `getToken()` is non-null.
 *  4. 401 → refresh succeeds → original request retried once → success.
 *  5. 401 → refresh returns null → ApiAuthError surfaces.
 *  6. 4xx ≠ 401 → ApiError carrying the parsed Problem Details body.
 *  7. 5xx → ApiServerError.
 *  8. Network failure (`fetch` rejects) propagates the underlying error.
 *
 * @see Requirements 2.3, 14.2, 14.6.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiAuthError, ApiError, ApiServerError, createApiClient } from './client';

/** Helper: build a JSON Response with a Problem Details body. */
function problemResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

/** Helper: build a JSON Response for successful cases. */
function jsonResponse<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createApiClient', () => {
  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchImpl = vi.fn();
  });

  it('GET returns parsed JSON on 200', async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse({ hello: 'world' }));
    const client = createApiClient({
      baseUrl: 'https://api.test',
      getToken: () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.get<{ hello: string }>('/v1/thing');

    expect(result).toEqual({ hello: 'world' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/thing');
    expect(init.method).toBe('GET');
  });

  it('POST sends JSON body with Content-Type: application/json', async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse({ ok: true }, 201));
    const client = createApiClient({
      baseUrl: '',
      getToken: () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.post<{ ok: boolean }>('/v1/thing', { a: 1 });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('attaches Authorization: Bearer <token> when getToken() returns non-null', async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse({}));
    const client = createApiClient({
      baseUrl: '',
      getToken: () => 'my.jwt.token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.get('/v1/secret');

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer my.jwt.token');
  });

  it('retries once after 401 → refresh success', async () => {
    fetchImpl
      .mockResolvedValueOnce(problemResponse(401, { title: 'expired', status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    let currentToken: string | null = 'old.token';
    const onRefresh = vi.fn(async () => {
      currentToken = 'new.token';
      return currentToken;
    });

    const client = createApiClient({
      baseUrl: '',
      getToken: () => currentToken,
      onRefresh,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.get<{ ok: boolean }>('/v1/me');

    expect(result).toEqual({ ok: true });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Second call uses the new token.
    const [, secondInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const headers = new Headers(secondInit.headers);
    expect(headers.get('Authorization')).toBe('Bearer new.token');
  });

  it('throws ApiAuthError when onRefresh returns null after a 401', async () => {
    fetchImpl.mockResolvedValueOnce(problemResponse(401, { title: 'expired', status: 401 }));
    const onRefresh = vi.fn(async () => null);

    const client = createApiClient({
      baseUrl: '',
      getToken: () => 'expired',
      onRefresh,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.get('/v1/me')).rejects.toBeInstanceOf(ApiAuthError);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws ApiError with the parsed Problem Details body on 422', async () => {
    const problem = {
      type: 'about:blank',
      title: 'Validation failed',
      status: 422,
      code: 'validation_failed',
    };
    fetchImpl.mockResolvedValueOnce(problemResponse(422, problem));

    const client = createApiClient({
      baseUrl: '',
      getToken: () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    try {
      await client.post('/v1/auth/register', { bad: 'input' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(422);
      expect(apiErr.problem).toEqual(problem);
    }
  });

  it('throws ApiServerError on 5xx', async () => {
    fetchImpl.mockResolvedValueOnce(problemResponse(503, { title: 'down', status: 503 }));

    const client = createApiClient({
      baseUrl: '',
      getToken: () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.get('/v1/thing')).rejects.toBeInstanceOf(ApiServerError);
  });

  it('propagates network-level failures as-is', async () => {
    const netErr = new TypeError('Failed to fetch');
    fetchImpl.mockRejectedValueOnce(netErr);

    const client = createApiClient({
      baseUrl: '',
      getToken: () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.get('/v1/thing')).rejects.toBe(netErr);
  });
});
