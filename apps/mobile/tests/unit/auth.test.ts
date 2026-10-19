import { describe, expect, it, vi } from 'vitest';

import {
  LOGOUT_TIMEOUT_MS,
  REFRESH_TOKEN_READ_TIMEOUT_MS,
  register,
  signIn,
  signOut,
} from '../../features/auth/auth';
import { SessionStore } from '../../features/auth/session-store';
import { ApiError, NetworkError } from '../../infrastructure/api/errors';
import { REFRESH_TOKEN_KEY, USER_ID_KEY } from '../../infrastructure/auth/token-store';
import { createFakeApi, createFakeSync, STUDIO_ID, USER_ID } from '../features-helpers';
import { createTokenStore } from '../helpers';

function session() {
  return {
    user: {
      id: USER_ID,
      studioId: STUDIO_ID,
      email: 'ada@example.com',
      displayName: 'Ada',
      avatarUrl: null,
      role: 'member',
      consents: {
        marketing: false,
        analytics: false,
        thirdParty: false,
        version: '2026-01',
        updatedAt: '2026-10-01T10:00:00.000Z',
      },
      createdAt: '2026-10-01T10:00:00.000Z',
      deletedAt: null,
    },
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    accessTokenExpiresIn: 900,
    refreshTokenExpiresIn: 2_592_000,
  };
}

function setup() {
  const api = createFakeApi();
  const sync = createFakeSync();
  const { store, secure } = createTokenStore();
  return { deps: { api, tokenStore: store, sync }, api, sync, store, secure };
}

describe('signIn', () => {
  it('stores the session with the user id, then refreshes the sync owner', async () => {
    const { deps, api, sync, store, secure } = setup();
    api.post.mockResolvedValue(session());

    const result = await signIn(deps, { email: ' Ada@Example.com ', password: 'secret' });

    expect(result).toEqual({ ok: true, userId: USER_ID });
    expect(api.post).toHaveBeenCalledWith(
      '/v1/auth/login',
      { email: 'ada@example.com', password: 'secret' },
      { authenticated: false },
    );
    expect(store.getAccessToken()).toBe('access-1');
    expect(secure.items.get(REFRESH_TOKEN_KEY)).toBe('refresh-1');
    expect(secure.items.get(USER_ID_KEY)).toBe(USER_ID);
    expect(sync.refreshOwner).toHaveBeenCalledTimes(1);
  });

  it('sends the Turnstile token in the cf-turnstile-token header', async () => {
    const { deps, api } = setup();
    api.post.mockResolvedValue(session());

    await signIn(deps, { email: 'ada@example.com', password: 'secret', turnstileToken: 'ts-1' });

    expect(api.post).toHaveBeenCalledWith(
      '/v1/auth/login',
      { email: 'ada@example.com', password: 'secret' },
      { authenticated: false, headers: { 'cf-turnstile-token': 'ts-1' } },
    );
  });

  it('sends no Turnstile header without a token', async () => {
    const { deps, api } = setup();
    api.post.mockResolvedValue(session());
    await signIn(deps, { email: 'ada@example.com', password: 'secret', turnstileToken: null });
    await signIn(deps, { email: 'ada@example.com', password: 'secret', turnstileToken: '' });
    expect(api.post).toHaveBeenCalledTimes(2);
    for (const call of api.post.mock.calls) {
      expect(call[2]).toEqual({ authenticated: false });
    }
  });

  it('validates the form before calling the API', async () => {
    const { deps, api } = setup();
    const result = await signIn(deps, { email: 'not-an-email', password: '' });
    expect(result).toEqual({
      ok: false,
      error: null,
      fieldErrors: { email: 'mobile.auth.errors.email', password: 'mobile.auth.errors.password' },
    });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('maps 401 to invalid credentials and stores nothing', async () => {
    const { deps, api, sync, secure } = setup();
    api.post.mockRejectedValue(new ApiError(401));
    const result = await signIn(deps, { email: 'ada@example.com', password: 'wrong' });
    expect(result).toMatchObject({ ok: false, error: { key: 'auth.errors.invalidCredentials' } });
    expect(secure.items.size).toBe(0);
    expect(sync.refreshOwner).not.toHaveBeenCalled();
  });

  it('reports the bot check and network failures', async () => {
    const { deps, api } = setup();
    api.post.mockRejectedValueOnce(
      new ApiError(403, {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        code: 'bot_challenge_failed',
      }),
    );
    expect(await signIn(deps, { email: 'ada@example.com', password: 'x' })).toMatchObject({
      error: { key: 'mobile.auth.errors.botCheck' },
    });
    api.post.mockRejectedValueOnce(new NetworkError('offline'));
    expect(await signIn(deps, { email: 'ada@example.com', password: 'x' })).toMatchObject({
      error: { key: 'errors.network' },
    });
  });

  it('rejects a malformed session response instead of storing it', async () => {
    const { deps, api, secure } = setup();
    api.post.mockResolvedValue({ accessToken: 'x' });
    const result = await signIn(deps, { email: 'ada@example.com', password: 'x' });
    expect(result.ok).toBe(false);
    expect(secure.items.size).toBe(0);
  });

  it('rethrows when cancelled', async () => {
    const { deps, api } = setup();
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    api.post.mockImplementation((...args: unknown[]) => {
      received = (args[2] as { signal?: AbortSignal }).signal;
      controller.abort();
      return Promise.reject(new Error('aborted'));
    });
    await expect(
      signIn(deps, { email: 'ada@example.com', password: 'x' }, controller.signal),
    ).rejects.toThrow('aborted');
    // The caller's signal reaches the request, so leaving the screen cancels it.
    expect(received).toBe(controller.signal);
  });

  it('starts a drain for the changes the user queued before signing in', async () => {
    const { deps, api, sync } = setup();
    api.post.mockResolvedValue(session());
    await signIn(deps, { email: 'ada@example.com', password: 'secret' });
    expect(sync.syncNow).toHaveBeenCalledTimes(1);
    expect(sync.refreshOwner.mock.invocationCallOrder[0]).toBeLessThan(
      sync.syncNow.mock.invocationCallOrder[0] ?? 0,
    );
  });
});

describe('register', () => {
  const input = {
    email: 'ada@example.com',
    password: 'long-enough',
    displayName: 'Ada',
    studioSlug: ' Studio-Lyon ',
    consents: { marketing: true, analytics: false, thirdParty: false },
  };

  it('normalises the studio slug and starts the session', async () => {
    const { deps, api, sync } = setup();
    api.post.mockResolvedValue(session());
    const result = await register(deps, input);
    expect(result.ok).toBe(true);
    expect(api.post).toHaveBeenCalledWith(
      '/v1/auth/register',
      expect.objectContaining({ studioSlug: 'studio-lyon', consents: input.consents }),
      { authenticated: false },
    );
    expect(sync.refreshOwner).toHaveBeenCalledTimes(1);
  });

  it('sends the Turnstile token like the web client', async () => {
    const { deps, api } = setup();
    api.post.mockResolvedValue(session());
    await register(deps, { ...input, turnstileToken: 'ts-2' });
    expect(api.post).toHaveBeenCalledWith('/v1/auth/register', expect.anything(), {
      authenticated: false,
      headers: { 'cf-turnstile-token': 'ts-2' },
    });
  });

  it('does not call the API, so keeps the token, when a field is invalid', async () => {
    const { deps, api } = setup();
    const result = await register(deps, { ...input, email: 'nope', turnstileToken: 'ts-3' });
    expect(result).toMatchObject({ ok: false, error: null });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('flags invalid fields', async () => {
    const { deps } = setup();
    const result = await register(deps, { ...input, password: 'short', displayName: ' ' });
    expect(result).toMatchObject({
      ok: false,
      fieldErrors: {
        password: 'mobile.auth.errors.password',
        displayName: 'mobile.auth.errors.displayName',
      },
    });
  });

  it('maps email_taken and studio_not_found', async () => {
    const { deps, api } = setup();
    const problem = (code: string) =>
      new ApiError(422, { type: 'about:blank', title: 'x', status: 422, code });
    api.post.mockRejectedValueOnce(problem('email_taken'));
    expect(await register(deps, input)).toMatchObject({
      error: { key: 'mobile.auth.errors.emailTaken' },
    });
    api.post.mockRejectedValueOnce(problem('studio_not_found'));
    expect(await register(deps, input)).toMatchObject({
      error: { key: 'mobile.auth.errors.studioNotFound' },
    });
  });
});

describe('signOut', () => {
  it('revokes server-side, clears the store, then refreshes the sync owner', async () => {
    const { deps, api, sync, store, secure } = setup();
    await store.saveSession({ ...session(), userId: USER_ID });
    api.post.mockResolvedValue(null);

    expect(await signOut(deps)).toBe(true);

    // Only this device's session is revoked: the refresh token names it.
    // No refresh-and-retry on 401: no biometric prompt, and the timeout bounds the call.
    expect(api.post).toHaveBeenCalledWith(
      '/v1/auth/logout',
      { refreshToken: 'refresh-1' },
      {
        signal: expect.any(AbortSignal) as AbortSignal,
        refreshOnUnauthorized: false,
      },
    );
    expect(secure.items.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(secure.items.has(USER_ID_KEY)).toBe(false);
    expect(store.getAccessToken()).toBeNull();
    expect(sync.refreshOwner).toHaveBeenCalledTimes(1);
  });

  it('still asks for the revocation when the refresh token cannot be read', async () => {
    const { deps, api, store, secure } = setup();
    await store.saveSession({ ...session(), userId: USER_ID });
    api.post.mockResolvedValue(null);
    secure.getItem = () => Promise.reject(new Error('keychain'));

    await signOut(deps);

    expect(api.post).toHaveBeenCalledWith('/v1/auth/logout', undefined, {
      signal: expect.any(AbortSignal) as AbortSignal,
      refreshOnUnauthorized: false,
    });
  });

  it('stops waiting for a stalled refresh-token read and still revokes and clears', async () => {
    vi.useFakeTimers();
    try {
      const { deps, api, store, secure } = setup();
      await store.saveSession({ ...session(), userId: USER_ID });
      api.post.mockResolvedValue(null);
      secure.getItem = () => new Promise<string | null>(() => undefined);

      const done = signOut(deps);
      await vi.advanceTimersByTimeAsync(REFRESH_TOKEN_READ_TIMEOUT_MS);

      expect(await done).toBe(true);
      expect(api.post).toHaveBeenCalledWith('/v1/auth/logout', undefined, {
        signal: expect.any(AbortSignal) as AbortSignal,
        refreshOnUnauthorized: false,
      });
      expect(secure.items.has(REFRESH_TOKEN_KEY)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('signs out locally even when the revocation fails', async () => {
    const { deps, api, store, secure } = setup();
    await store.saveSession({ ...session(), userId: USER_ID });
    api.post.mockRejectedValue(new NetworkError('offline'));
    await signOut(deps);
    expect(secure.items.has(REFRESH_TOKEN_KEY)).toBe(false);
  });

  it('skips the revocation without an access token (no refresh, no prompt)', async () => {
    const { deps, api, sync } = setup();
    await signOut(deps);
    expect(api.post).not.toHaveBeenCalled();
    expect(sync.refreshOwner).toHaveBeenCalledTimes(1);
  });

  it('stops waiting for the revocation after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const { deps, api, store, secure } = setup();
      await store.saveSession({ ...session(), userId: USER_ID });
      api.post.mockImplementation(
        (...args: unknown[]) =>
          new Promise((_resolve, reject) => {
            const { signal } = args[2] as { signal: AbortSignal };
            signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
      );
      const done = signOut(deps);
      await vi.advanceTimersByTimeAsync(LOGOUT_TIMEOUT_MS);
      await done;
      expect(secure.items.has(REFRESH_TOKEN_KEY)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('locks the session and reports it when the secure storage cannot be cleared', async () => {
    const { deps, api, sync, store, secure } = setup();
    await store.saveSession({ ...session(), userId: USER_ID });
    api.post.mockResolvedValue(null);
    secure.deleteItem = () => Promise.reject(new Error('keychain'));

    expect(await signOut(deps)).toBe(false);

    expect(store.getAccessToken()).toBeNull();
    expect(store.isUnlocked()).toBe(false);
    expect(sync.refreshOwner).toHaveBeenCalledTimes(1);
  });
});

describe('SessionStore', () => {
  it('starts loading, then follows the stored user', async () => {
    const { store } = setup();
    const sessions = new SessionStore(store);
    const listener = vi.fn();
    sessions.subscribe(listener);
    expect(sessions.get()).toEqual({ status: 'loading' });

    expect(await sessions.refresh()).toEqual({ status: 'signed-out' });
    await store.saveSession({ ...session(), userId: USER_ID });
    expect(await sessions.refresh()).toEqual({ status: 'signed-in', userId: USER_ID });
    await store.clear();
    expect(await sessions.refresh()).toEqual({ status: 'signed-out' });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('does not notify when nothing changed', async () => {
    const { store } = setup();
    const sessions = new SessionStore(store);
    await sessions.refresh();
    const listener = vi.fn();
    sessions.subscribe(listener);
    await sessions.refresh();
    expect(listener).not.toHaveBeenCalled();
  });

  it('lets the latest refresh win', async () => {
    let resolveFirst: (value: string | null) => void = () => undefined;
    const reads = [
      new Promise<string | null>((resolve) => {
        resolveFirst = resolve;
      }),
      Promise.resolve(null),
    ];
    const sessions = new SessionStore({ getUserId: () => reads.shift() ?? Promise.resolve(null) });
    const first = sessions.refresh();
    await sessions.refresh();
    resolveFirst(USER_ID);
    await first;
    expect(sessions.get()).toEqual({ status: 'signed-out' });
  });

  it('treats an unreadable store as signed out', async () => {
    const sessions = new SessionStore({ getUserId: () => Promise.reject(new Error('keychain')) });
    expect(await sessions.refresh()).toEqual({ status: 'signed-out' });
  });
});
