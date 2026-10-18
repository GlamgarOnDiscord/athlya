import { describe, expect, it } from 'vitest';

import {
  BIOMETRIC_UNLOCK_KEY,
  REFRESH_TOKEN_KEY,
  USER_ID_KEY,
} from '../../infrastructure/auth/token-store';
import { createTokenStore } from '../helpers';

const SESSION = {
  userId: 'user-1',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessTokenExpiresIn: 900,
};

describe('TokenStore (tasks 11.2 / 11.3)', () => {
  it('keeps the access token in memory and only the refresh token in secure storage', async () => {
    const { store, secure } = createTokenStore();
    await expect(store.saveSession(SESSION)).resolves.toBe(true);

    expect(store.getAccessToken()).toBe('access-1');
    expect(Object.fromEntries(secure.items)).toEqual({
      [REFRESH_TOKEN_KEY]: 'refresh-1',
      [USER_ID_KEY]: 'user-1',
    });
    await expect(store.getUserId()).resolves.toBe('user-1');
  });

  it('rotates both tokens on refresh', async () => {
    const { store, secure } = createTokenStore();
    await store.saveSession(SESSION);
    await store.saveSession({
      userId: 'user-1',
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accessTokenExpiresIn: 900,
    });

    expect(store.getAccessToken()).toBe('access-2');
    expect(secure.items.get(REFRESH_TOKEN_KEY)).toBe('refresh-2');
  });

  it('stops returning the access token shortly before it expires', async () => {
    let now = 0;
    const { store } = createTokenStore(() => now);
    await store.saveSession(SESSION);

    now = 900_000 - 31_000;
    expect(store.getAccessToken()).toBe('access-1');
    now = 900_000 - 30_000;
    expect(store.getAccessToken()).toBeNull();
  });

  it('reads the refresh token without a prompt when biometric unlock is off', async () => {
    const { store, secure, biometrics } = createTokenStore();
    secure.items.set(REFRESH_TOKEN_KEY, 'refresh-1');

    await expect(store.readRefreshToken()).resolves.toBe('refresh-1');
    expect(biometrics.prompts).toBe(0);
  });

  it('requires a successful biometric prompt once per unlock period when enabled', async () => {
    const { store, secure, biometrics } = createTokenStore();
    secure.items.set(REFRESH_TOKEN_KEY, 'refresh-1');
    secure.items.set(BIOMETRIC_UNLOCK_KEY, 'true');

    await expect(store.readRefreshToken()).resolves.toBe('refresh-1');
    await expect(store.readRefreshToken()).resolves.toBe('refresh-1');
    expect(biometrics.prompts).toBe(1);

    store.lock();
    await expect(store.readRefreshToken()).resolves.toBe('refresh-1');
    expect(biometrics.prompts).toBe(2);
  });

  it('shares one prompt between concurrent unlocks', async () => {
    const { store, secure, biometrics } = createTokenStore();
    secure.items.set(BIOMETRIC_UNLOCK_KEY, 'true');

    await expect(Promise.all([store.unlock(), store.unlock()])).resolves.toEqual([true, true]);
    expect(biometrics.prompts).toBe(1);
  });

  it('lets lock() win over a prompt that is still open', async () => {
    const { store, secure, biometrics } = createTokenStore();
    secure.items.set(REFRESH_TOKEN_KEY, 'refresh-1');
    secure.items.set(BIOMETRIC_UNLOCK_KEY, 'true');
    let release = (): void => undefined;
    biometrics.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pending = store.readRefreshToken();
    await Promise.resolve();
    await Promise.resolve();
    store.lock();
    release();

    await expect(pending).resolves.toBeNull();
    expect(store.isUnlocked()).toBe(false);
  });

  it('withholds the refresh token when the prompt is declined or biometrics vanished', async () => {
    const { store, secure, biometrics } = createTokenStore();
    secure.items.set(REFRESH_TOKEN_KEY, 'refresh-1');
    secure.items.set(BIOMETRIC_UNLOCK_KEY, 'true');

    biometrics.accept = false;
    await expect(store.readRefreshToken()).resolves.toBeNull();

    biometrics.accept = true;
    biometrics.available = false;
    await expect(store.readRefreshToken()).resolves.toBeNull();
    expect(store.isUnlocked()).toBe(false);
  });

  it('only enables biometric unlock after a successful prompt', async () => {
    const { store, biometrics } = createTokenStore();

    biometrics.available = false;
    await expect(store.setBiometricUnlockEnabled(true)).resolves.toBe(false);
    biometrics.available = true;
    biometrics.accept = false;
    await expect(store.setBiometricUnlockEnabled(true)).resolves.toBe(false);
    await expect(store.isBiometricUnlockEnabled()).resolves.toBe(false);

    biometrics.accept = true;
    await expect(store.setBiometricUnlockEnabled(true)).resolves.toBe(true);
    await expect(store.isBiometricUnlockEnabled()).resolves.toBe(true);
    await expect(store.setBiometricUnlockEnabled(false)).resolves.toBe(false);
    await expect(store.isBiometricUnlockEnabled()).resolves.toBe(false);
  });

  it('clear() forgets both tokens and the user but keeps the biometric preference', async () => {
    const { store, secure } = createTokenStore();
    await store.saveSession(SESSION);
    secure.items.set(BIOMETRIC_UNLOCK_KEY, 'true');

    await store.clear();

    expect(store.getAccessToken()).toBeNull();
    await expect(store.hasStoredSession()).resolves.toBe(false);
    await expect(store.getUserId()).resolves.toBeNull();
    expect(secure.items.get(BIOMETRIC_UNLOCK_KEY)).toBe('true');
  });

  it('rejects a session saved for a generation that clear() invalidated', async () => {
    const { store, secure } = createTokenStore();
    const generation = store.generation();
    await store.clear();

    await expect(store.saveSession(SESSION, generation)).resolves.toBe(false);
    expect(store.getAccessToken()).toBeNull();
    expect(secure.items.has(REFRESH_TOKEN_KEY)).toBe(false);
    await expect(store.saveSession(SESSION, store.generation())).resolves.toBe(true);
  });

  it('keeps the rotated refresh token but stays locked when lock() ran meanwhile', async () => {
    const { store, secure } = createTokenStore();
    const generation = store.generation();
    store.lock();

    await expect(store.saveSession(SESSION, generation)).resolves.toBe(false);
    expect(store.getAccessToken()).toBeNull();
    expect(store.isUnlocked()).toBe(false);
    expect(secure.items.get(REFRESH_TOKEN_KEY)).toBe('refresh-1');
  });
});
