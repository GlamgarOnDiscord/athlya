import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  deleteAccount,
  isDeleteConfirmed,
  rejectedChanges,
  requestDataExport,
  toggleBiometricUnlock,
} from '../../features/settings/settings';
import { ApiError, NetworkError } from '../../infrastructure/api/errors';
import { REFRESH_TOKEN_KEY, USER_ID_KEY } from '../../infrastructure/auth/token-store';
import { AppleHealthLinkStore } from '../../infrastructure/health/link-store';
import { createMemoryKeyValueStore } from '../../infrastructure/storage/key-value-store';
import { MutationQueue } from '../../infrastructure/sync/queue';
import { createFakeApi, createFakeSync, USER_ID } from '../features-helpers';
import { createQueue, createTokenStore } from '../helpers';

describe('toggleBiometricUnlock', () => {
  it('renders the state the token store actually reached', async () => {
    const { store, biometrics } = createTokenStore();
    expect(await toggleBiometricUnlock(store, true)).toEqual({ enabled: true, failed: false });
    expect(await store.isBiometricUnlockEnabled()).toBe(true);

    expect(await toggleBiometricUnlock(store, false)).toEqual({ enabled: false, failed: false });

    biometrics.accept = false;
    expect(await toggleBiometricUnlock(store, true)).toEqual({ enabled: false, failed: true });
    biometrics.available = false;
    biometrics.accept = true;
    expect(await toggleBiometricUnlock(store, true)).toEqual({ enabled: false, failed: true });
    expect(await store.isBiometricUnlockEnabled()).toBe(false);
  });

  it('keeps the previous state when the store fails', async () => {
    const failing = { setBiometricUnlockEnabled: () => Promise.reject(new Error('keychain')) };
    expect(await toggleBiometricUnlock(failing, true)).toEqual({ enabled: false, failed: true });
    // A failed disable leaves the protection on: the switch must say so.
    expect(await toggleBiometricUnlock(failing, false)).toEqual({ enabled: true, failed: true });
  });
});

describe('rejectedChanges', () => {
  it('lists only the user’s dead letters, newest first, with a label per kind', () => {
    let now = new Date('2026-10-18T08:00:00.000Z');
    const local = new MutationQueue(createMemoryKeyValueStore(), {
      uuid: randomUUID,
      now: () => now,
    });
    const book = local.enqueue({ ownerId: USER_ID, kind: 'bookClass', path: '/v1/reservations' });
    const other = local.enqueue({ ownerId: 'other', kind: 'logSession', path: '/v1/sessions' });
    const custom = local.enqueue({ ownerId: USER_ID, kind: 'renameThing', path: '/v1/x' });
    local.moveToDeadLetter(book.id, { status: 422, problemCode: 'class_in_past' });
    now = new Date('2026-10-18T09:00:00.000Z');
    local.moveToDeadLetter(custom.id, { status: 404 });
    local.moveToDeadLetter(other.id, { status: 422 });

    expect(rejectedChanges(local.deadLetters(USER_ID))).toEqual([
      {
        id: custom.id,
        kindKey: 'mobile.settings.rejected.kinds.other',
        status: 404,
        problemCode: null,
        failedAt: '2026-10-18T09:00:00.000Z',
      },
      {
        id: book.id,
        kindKey: 'mobile.settings.rejected.kinds.bookClass',
        status: 422,
        problemCode: 'class_in_past',
        failedAt: '2026-10-18T08:00:00.000Z',
      },
    ]);
  });

  it('labels a rejected Apple Health import', () => {
    const local = new MutationQueue(createMemoryKeyValueStore(), { uuid: randomUUID });
    const imported = local.enqueue({
      ownerId: USER_ID,
      kind: 'importHealthWorkout',
      path: '/v1/sessions',
    });
    local.moveToDeadLetter(imported.id, { status: 422 });

    expect(rejectedChanges(local.deadLetters(USER_ID))[0]?.kindKey).toBe(
      'mobile.settings.rejected.kinds.importHealthWorkout',
    );
  });
});

describe('requestDataExport', () => {
  it('posts to the export endpoint with an idempotency key', async () => {
    const api = createFakeApi();
    const jobId = randomUUID();
    api.post.mockResolvedValue({ jobId });
    expect(await requestDataExport({ api, uuid: randomUUID })).toEqual({ ok: true, jobId });
    expect(api.post).toHaveBeenCalledWith(
      '/v1/members/me/export',
      {},
      { idempotencyKey: expect.any(String) as string },
    );
  });

  it('explains the daily limit and other failures', async () => {
    const api = createFakeApi();
    api.post.mockRejectedValueOnce(new ApiError(429));
    expect(await requestDataExport({ api, uuid: randomUUID })).toMatchObject({
      ok: false,
      error: { key: 'mobile.settings.export.alreadyRequested' },
    });
    api.post.mockResolvedValueOnce({ jobId: 'not-a-uuid' });
    expect(await requestDataExport({ api, uuid: randomUUID })).toMatchObject({ ok: false });
  });
});

describe('account deletion', () => {
  it('requires the exact confirmation word', () => {
    expect(isDeleteConfirmed('DELETE', 'DELETE')).toBe(true);
    expect(isDeleteConfirmed(' DELETE ', 'DELETE')).toBe(true);
    expect(isDeleteConfirmed('delete', 'DELETE')).toBe(false);
    expect(isDeleteConfirmed('', 'DELETE')).toBe(false);
  });

  async function setup() {
    const api = createFakeApi();
    const sync = createFakeSync();
    const { queue } = createQueue();
    const { store, secure } = createTokenStore();
    await store.saveSession({
      userId: USER_ID,
      accessToken: 'a',
      refreshToken: 'r',
      accessTokenExpiresIn: 900,
    });
    const mine = queue.enqueue({ ownerId: USER_ID, kind: 'logSession', path: '/v1/sessions' });
    const rejected = queue.enqueue({
      ownerId: USER_ID,
      kind: 'bookClass',
      path: '/v1/reservations',
    });
    queue.moveToDeadLetter(rejected.id, { status: 422 });
    const theirs = queue.enqueue({ ownerId: 'other', kind: 'logSession', path: '/v1/sessions' });
    const healthLinks = new AppleHealthLinkStore(createMemoryKeyValueStore());
    healthLinks.connect(USER_ID, 0);
    healthLinks.connect('other', 0);
    return {
      deps: { api, sync, queue, tokenStore: store, healthLinks, uuid: randomUUID },
      api,
      healthLinks,
      sync,
      queue,
      secure,
      mine,
      theirs,
    };
  }

  it('calls DELETE /v1/auth/me, then forgets the account on this device', async () => {
    const { deps, api, sync, queue, secure, mine, theirs, healthLinks } = await setup();
    api.del.mockResolvedValue({ deleted: true });

    expect(await deleteAccount(deps, USER_ID)).toEqual({ ok: true, cleanupFailed: false });

    expect(healthLinks.get(USER_ID)).toBeNull();
    expect(healthLinks.get('other')).not.toBeNull();
    expect(api.del).toHaveBeenCalledWith('/v1/auth/me', {
      idempotencyKey: expect.any(String) as string,
    });
    expect(queue.has(mine.id)).toBe(false);
    expect(queue.has(theirs.id)).toBe(true);
    expect(queue.deadLetters(USER_ID)).toEqual([]);
    expect(secure.items.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(secure.items.has(USER_ID_KEY)).toBe(false);
    expect(sync.refreshOwner).toHaveBeenCalledTimes(1);
  });

  it('keeps everything when the API call fails', async () => {
    const { deps, api, sync, queue, secure, mine } = await setup();
    api.del.mockRejectedValue(new NetworkError('offline'));
    const refreshOwner = vi.mocked(sync.refreshOwner);

    expect(await deleteAccount(deps, USER_ID)).toEqual({
      ok: false,
      error: { key: 'errors.network', authRequired: false },
    });
    expect(queue.has(mine.id)).toBe(true);
    expect(secure.items.has(REFRESH_TOKEN_KEY)).toBe(true);
    expect(refreshOwner).not.toHaveBeenCalled();
  });

  it('never rejects once the server deleted the account, and still clears what it can', async () => {
    const { deps, api, sync, store } = await setupWithFailingStorage();
    api.del.mockResolvedValue({ deleted: true });

    const result = await deleteAccount(deps, USER_ID);

    expect(result).toEqual({ ok: true, cleanupFailed: true });
    // The secure storage refused to forget the session: it is locked in memory instead.
    expect(store.getAccessToken()).toBeNull();
    expect(store.isUnlocked()).toBe(false);
    expect(sync.refreshOwner).toHaveBeenCalledTimes(1);
  });

  async function setupWithFailingStorage() {
    const base = await setup();
    base.secure.deleteItem = () => Promise.reject(new Error('keychain'));
    const queue = {
      pendingFor: () => {
        throw new Error('mmkv');
      },
      remove: () => false,
      deadLetters: () => [],
      discardDeadLetter: () => false,
    };
    return {
      ...base,
      store: base.deps.tokenStore,
      deps: { ...base.deps, queue },
    };
  }
});
