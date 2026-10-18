import { describe, expect, it, vi } from 'vitest';

import { buildUrl, createApiClient } from '../../infrastructure/api/client';
import { ApiError, AuthRequiredError, NetworkError } from '../../infrastructure/api/errors';
import { jsonResponse } from '../helpers';

type FetchArgs = [input: string, init: RequestInit];

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

function setup(
  responses: (Response | Error)[],
  options: { token?: string | null; refresh?: () => Promise<string | null> } = {},
) {
  const fetchImpl = vi.fn((..._args: FetchArgs) => {
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected fetch');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  let token = options.token === undefined ? 'access-1' : options.token;
  const refresh = vi.fn(
    options.refresh ??
      (() => {
        token = 'access-2';
        return Promise.resolve(token);
      }),
  );
  const client = createApiClient({
    baseUrl: 'https://api.athlya.test/',
    tokens: { getAccessToken: () => token },
    refreshAccessToken: refresh,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, fetchImpl, refresh };
}

describe('buildUrl', () => {
  it('joins base and path with exactly one slash', () => {
    expect(buildUrl('https://a.test/', '/v1/x')).toBe('https://a.test/v1/x');
    expect(buildUrl('https://a.test', 'v1/x')).toBe('https://a.test/v1/x');
  });
});

describe('createApiClient', () => {
  it('attaches the bearer token and the Idempotency-Key header', async () => {
    const { client, fetchImpl } = setup([jsonResponse(201, { id: 'r1' })]);

    const body = await client.post<{ id: string }>(
      '/v1/reservations',
      { classId: 'c1' },
      { idempotencyKey: 'key-1' },
    );

    expect(body).toEqual({ id: 'r1' });
    const [url, init] = fetchImpl.mock.calls[0] as FetchArgs;
    expect(url).toBe('https://api.athlya.test/v1/reservations');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ classId: 'c1' }));
    expect(headersOf(init)).toMatchObject({
      Authorization: 'Bearer access-1',
      'Idempotency-Key': 'key-1',
      'Content-Type': 'application/json',
    });
  });

  it('sends extra headers but never lets them replace the client-owned ones', async () => {
    const { client, fetchImpl } = setup([jsonResponse(200, {})]);
    await client.get('/v1/me/progression?window=30', {
      headers: {
        'If-None-Match': '"abc"',
        authorization: 'Bearer forged',
        ACCEPT: 'text/html',
        'idempotency-key': 'forged',
      },
    });
    const [, init] = fetchImpl.mock.calls[0] as FetchArgs;
    expect(headersOf(init)).toEqual({
      'If-None-Match': '"abc"',
      Accept: 'application/json',
      Authorization: 'Bearer access-1',
    });
  });

  it('omits the Authorization header when there is no token', async () => {
    const { client, fetchImpl } = setup([jsonResponse(200, {})], { token: null });
    await client.get('/v1/classes');
    const [, init] = fetchImpl.mock.calls[0] as FetchArgs;
    expect(headersOf(init).Authorization).toBeUndefined();
  });

  it('never sends the available access token on anonymous calls', async () => {
    const { client, fetchImpl } = setup([jsonResponse(200, {})]);
    await client.post('/v1/auth/login', {}, { authenticated: false });
    const [, init] = fetchImpl.mock.calls[0] as FetchArgs;
    expect(headersOf(init).Authorization).toBeUndefined();
  });

  it('rethrows a caller abort instead of reporting a network failure', async () => {
    const fetchImpl = vi.fn(
      (_input: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    const client = createApiClient({
      baseUrl: 'https://api.athlya.test',
      tokens: { getAccessToken: () => null },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const controller = new AbortController();
    const pending = client.send('POST', '/v1/sessions', {}, { signal: controller.signal });
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(NetworkError);
    expect((error as Error).name).toBe('AbortError');
  });

  it('refreshes once on 401 and retries once with the new token and the same key', async () => {
    const { client, fetchImpl, refresh } = setup([
      jsonResponse(401, { title: 'Unauthorized', status: 401 }),
      jsonResponse(201, { ok: true }),
    ]);

    await expect(client.post('/v1/sessions', { a: 1 }, { idempotencyKey: 'k' })).resolves.toEqual({
      ok: true,
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    const [, retry] = fetchImpl.mock.calls[1] as FetchArgs;
    expect(headersOf(retry)).toMatchObject({
      Authorization: 'Bearer access-2',
      'Idempotency-Key': 'k',
    });
  });

  it('returns a 401 as is when refreshOnUnauthorized is false', async () => {
    const { client, fetchImpl, refresh } = setup([jsonResponse(401, { title: 'x', status: 401 })]);
    await expect(
      client.post('/v1/auth/logout', undefined, { refreshOnUnauthorized: false }),
    ).rejects.toMatchObject({ name: 'ApiError', status: 401 });
    expect(refresh).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('raises AuthRequiredError when the retry is still 401', async () => {
    const { client, refresh } = setup([jsonResponse(401), jsonResponse(401)]);
    await expect(client.get('/v1/members/me')).rejects.toBeInstanceOf(AuthRequiredError);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('raises AuthRequiredError without retrying when the refresh fails', async () => {
    const { client, fetchImpl } = setup([jsonResponse(401)], {
      refresh: () => Promise.resolve(null),
    });
    await expect(client.get('/v1/members/me')).rejects.toBeInstanceOf(AuthRequiredError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not refresh on 401 for anonymous requests', async () => {
    const { client, refresh } = setup([
      jsonResponse(401, { title: 'Bad credentials', status: 401 }),
    ]);
    const response = await client.send('POST', '/v1/auth/login', {}, { authenticated: false });
    expect(response.status).toBe(401);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('send() reports non-2xx statuses instead of throwing', async () => {
    const { client } = setup([jsonResponse(503, { title: 'Down', status: 503 })]);
    const response = await client.send('POST', '/v1/sessions', {});
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ title: 'Down', status: 503 });
  });

  it('typed helpers throw ApiError carrying the Problem Details', async () => {
    const problem = { type: 'about:blank', title: 'Full', status: 409, code: 'class_full' };
    const { client } = setup([jsonResponse(409, problem, 'application/problem+json')]);
    const error = await client.post('/v1/reservations', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).problem?.code).toBe('class_full');
  });

  it('returns null for empty bodies (204)', async () => {
    const { client } = setup([new Response(null, { status: 204 })]);
    await expect(client.del('/v1/reservations/r1')).resolves.toBeNull();
  });

  it('wraps fetch failures in NetworkError', async () => {
    const { client } = setup([new TypeError('Network request failed')]);
    await expect(client.send('POST', '/v1/sessions', {})).rejects.toBeInstanceOf(NetworkError);
  });

  it('aborts and raises NetworkError after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_input: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
      );
      const client = createApiClient({
        baseUrl: 'https://api.athlya.test',
        tokens: { getAccessToken: () => null },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000,
      });
      const pending = client.send('GET', '/v1/classes');
      const assertion = expect(pending).rejects.toThrow(/timed out/u);
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
