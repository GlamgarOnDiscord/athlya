import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../../infrastructure/api/client';
import { ApiError } from '../../infrastructure/api/errors';
import { createSessionRefresher } from '../../infrastructure/auth/session';
import { REFRESH_TOKEN_KEY } from '../../infrastructure/auth/token-store';
import { createTokenStore, jsonResponse } from '../helpers';

const USER = {
  id: '6f1c2a4e-3b7d-4e8f-9a0b-1c2d3e4f5a6b',
  studioId: '7a2b3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d',
  email: 'member@athlya.test',
  displayName: 'Member',
  avatarUrl: null,
  role: 'member',
  consents: {
    marketing: false,
    analytics: false,
    thirdParty: false,
    version: '2026-01',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
};

function session(n: number) {
  return {
    user: USER,
    accessToken: `access-${String(n)}`,
    refreshToken: `refresh-${String(n)}`,
    accessTokenExpiresIn: 900,
    refreshTokenExpiresIn: 2_592_000,
  };
}

describe('createSessionRefresher', () => {
  it('exchanges the stored refresh token and rotates both tokens', async () => {
    const { store, secure } = createTokenStore();
    secure.items.set(REFRESH_TOKEN_KEY, 'refresh-0');
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(200, session(1))));
    const refresh = createSessionRefresher({
      baseUrl: 'https://api.athlya.test',
      tokenStore: store,
      fetchImpl: fetchImpl,
    });

    await expect(refresh()).resolves.toBe('access-1');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.athlya.test/v1/auth/refresh');
    expect(JSON.parse(init.body as string)).toEqual({ refreshToken: 'refresh-0' });
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(store.getAccessToken()).toBe('access-1');
    expect(secure.items.get(REFRESH_TOKEN_KEY)).toBe('refresh-1');
  });

  it('shares one in-flight refresh between concurrent callers (single-use tokens)', async () => {
    const { store, secure } = createTokenStore();
    secure.items.set(REFRESH_TOKEN_KEY, 'refresh-0');
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(200, session(1))));
    const refresh = createSessionRefresher({
      baseUrl: 'https://api.athlya.test',
      tokenStore: store,
      fetchImpl: fetchImpl,
    });

    const results = await Promise.all([refresh(), refresh(), refresh()]);

    expect(results).toEqual(['access-1', 'access-1', 'access-1']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('clears the session when the API rejects the refresh token', async () => {
    const { store, secure } = createTokenStore();
    secure.items.set(REFRESH_TOKEN_KEY, 'refresh-0');
    const refresh = createSessionRefresher({
      baseUrl: 'https://api.athlya.test',
      tokenStore: store,
      fetchImpl: () => Promise.resolve(jsonResponse(401)),
    });

    await expect(refresh()).resolves.toBeNull();
    expect(secure.items.has(REFRESH_TOKEN_KEY)).toBe(false);
  });

  it('resolves null without a network call when nothing is stored', async () => {
    const { store } = createTokenStore();
    const fetchImpl = vi.fn();
    const refresh = createSessionRefresher({
      baseUrl: 'https://api.athlya.test',
      tokenStore: store,
      fetchImpl: fetchImpl,
    });
    await expect(refresh()).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('drops a refresh that completes after sign-out', async () => {
    const { store, secure } = createTokenStore();
    secure.items.set(REFRESH_TOKEN_KEY, 'refresh-0');
    let respond = (_response: Response): void => undefined;
    const fetchImpl = (() =>
      new Promise<Response>((resolve) => {
        respond = resolve;
      })) as unknown as typeof fetch;
    const refresh = createSessionRefresher({
      baseUrl: 'https://api.athlya.test',
      tokenStore: store,
      fetchImpl,
    });

    const pending = refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await store.clear();
    respond(jsonResponse(200, session(1)));

    await expect(pending).resolves.toBeNull();
    expect(store.getAccessToken()).toBeNull();
    expect(secure.items.has(REFRESH_TOKEN_KEY)).toBe(false);
  });

  it('stores the user id of the refreshed session', async () => {
    const { store, secure } = createTokenStore();
    secure.items.set(REFRESH_TOKEN_KEY, 'refresh-0');
    const refresh = createSessionRefresher({
      baseUrl: 'https://api.athlya.test',
      tokenStore: store,
      fetchImpl: () => Promise.resolve(jsonResponse(200, session(1))),
    });
    await refresh();
    await expect(store.getUserId()).resolves.toBe(USER.id);
  });

  it('rejects on transient failures and keeps the stored token', async () => {
    const { store, secure } = createTokenStore();
    secure.items.set(REFRESH_TOKEN_KEY, 'refresh-0');
    const refresh = createSessionRefresher({
      baseUrl: 'https://api.athlya.test',
      tokenStore: store,
      fetchImpl: () => Promise.resolve(jsonResponse(503)),
    });
    await expect(refresh()).rejects.toBeInstanceOf(ApiError);
    expect(secure.items.get(REFRESH_TOKEN_KEY)).toBe('refresh-0');
  });

  it('plugs into the API client: a 401 triggers the refresh and the retry succeeds', async () => {
    const { store, secure } = createTokenStore();
    secure.items.set(REFRESH_TOKEN_KEY, 'refresh-0');
    const responses = [
      jsonResponse(401),
      jsonResponse(200, session(1)),
      jsonResponse(200, { ok: 1 }),
    ];
    const fetchImpl = (() => Promise.resolve(responses.shift())) as unknown as typeof fetch;
    const api = createApiClient({
      baseUrl: 'https://api.athlya.test',
      tokens: store,
      refreshAccessToken: createSessionRefresher({
        baseUrl: 'https://api.athlya.test',
        tokenStore: store,
        fetchImpl,
      }),
      fetchImpl,
    });

    await expect(api.get('/v1/members/me')).resolves.toEqual({ ok: 1 });
  });
});
