import { describe, expect, it } from 'vitest';

import {
  isOnlineState,
  SyncController,
  type ConnectivitySource,
  type SyncState,
} from '../../infrastructure/sync/sync-controller';
import { createQueue, OWNER } from '../helpers';

import type { ApiClient, ApiResponse } from '../../infrastructure/api/client';

class FakeConnectivity implements ConnectivitySource {
  public online: boolean;
  readonly #listeners = new Set<(online: boolean) => void>();

  public constructor(online: boolean) {
    this.online = online;
  }

  public isOnline(): boolean {
    return this.online;
  }

  public subscribe(listener: (online: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  public set(online: boolean): void {
    this.online = online;
    for (const listener of this.#listeners) listener(online);
  }
}

function okApi(): { api: Pick<ApiClient, 'send'>; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    api: {
      send: (_method, path) => {
        sent.push(path);
        return Promise.resolve<ApiResponse>({ status: 201, headers: new Headers(), body: null });
      },
    },
  };
}

const owner = () => Promise.resolve(OWNER);

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('isOnlineState', () => {
  it('needs a connection and no negative reachability answer', () => {
    expect(isOnlineState({ isConnected: true, isInternetReachable: true })).toBe(true);
    expect(isOnlineState({ isConnected: true, isInternetReachable: null })).toBe(true);
    expect(isOnlineState({ isConnected: true, isInternetReachable: false })).toBe(false);
    expect(isOnlineState({ isConnected: false, isInternetReachable: true })).toBe(false);
    expect(isOnlineState({ isConnected: null, isInternetReachable: null })).toBe(false);
  });
});

describe('SyncController (task 11.7)', () => {
  it('drains automatically when connectivity comes back', async () => {
    const { queue } = createQueue();
    queue.enqueue({ ownerId: OWNER, kind: 'logSession', path: '/v1/sessions' });
    const connectivity = new FakeConnectivity(false);
    const { api, sent } = okApi();
    const controller = new SyncController({ queue, api, getOwnerId: owner, connectivity });
    const stop = controller.start();
    await flush();

    expect(controller.getState().status).toBe('offline');
    expect(controller.getState().pending).toBe(1);

    connectivity.set(true);
    await flush();

    expect(sent).toEqual(['/v1/sessions']);
    expect(controller.getState()).toMatchObject({ status: 'idle', pending: 0 });
    stop();
  });

  it('drains at start when already online', async () => {
    const { queue } = createQueue();
    queue.enqueue({ ownerId: OWNER, kind: 'a', path: '/v1/a' });
    const { api, sent } = okApi();
    const stop = new SyncController({
      queue,
      api,
      getOwnerId: owner,
      connectivity: new FakeConnectivity(true),
    }).start();
    await flush();
    expect(sent).toEqual(['/v1/a']);
    stop();
  });

  it('publishes syncing progress while the drain runs', async () => {
    const { queue } = createQueue();
    queue.enqueue({ ownerId: OWNER, kind: 'a', path: '/v1/a' });
    queue.enqueue({ ownerId: OWNER, kind: 'b', path: '/v1/b' });
    const { api } = okApi();
    const controller = new SyncController({
      queue,
      api,
      getOwnerId: owner,
      connectivity: new FakeConnectivity(true),
    });
    const states: SyncState[] = [];
    controller.subscribe(() => states.push(controller.getState()));

    await controller.syncNow();

    const syncing = states.filter((s) => s.status === 'syncing');
    expect(syncing.length).toBeGreaterThan(0);
    expect(syncing.every((s) => s.total === 2)).toBe(true);
    expect(Math.max(...syncing.map((s) => s.processed))).toBe(2);
    expect(controller.getState()).toMatchObject({ status: 'idle', total: 0, processed: 0 });
    expect(controller.getState().lastResult?.acknowledged).toBe(2);
  });

  it('never runs two drains at once and coalesces calls into one follow-up drain', async () => {
    const { queue } = createQueue();
    queue.enqueue({ ownerId: OWNER, kind: 'a', path: '/v1/a' });
    let inFlight = 0;
    let maxInFlight = 0;
    const sent: string[] = [];
    let firstSent = (): void => undefined;
    const firstInFlight = new Promise<void>((resolve) => {
      firstSent = resolve;
    });
    const api: Pick<ApiClient, 'send'> = {
      send: async (_method, path) => {
        firstSent();
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        sent.push(path);
        await flush();
        inFlight -= 1;
        return { status: 201, headers: new Headers(), body: null };
      },
    };
    const controller = new SyncController({
      queue,
      api,
      getOwnerId: owner,
      connectivity: new FakeConnectivity(true),
    });

    const first = controller.syncNow();
    await firstInFlight;
    queue.enqueue({ ownerId: OWNER, kind: 'b', path: '/v1/b' });
    const second = controller.syncNow();
    const third = controller.syncNow();
    await Promise.all([first, second, third]);

    expect(maxInFlight).toBe(1);
    expect(sent).toEqual(['/v1/a', '/v1/b']);
    expect(queue.size).toBe(0);
  });

  it('resolves null and stays offline when there is no network', async () => {
    const { queue } = createQueue();
    queue.enqueue({ ownerId: OWNER, kind: 'a', path: '/v1/a' });
    const { api, sent } = okApi();
    const controller = new SyncController({
      queue,
      api,
      getOwnerId: owner,
      connectivity: new FakeConnectivity(false),
    });
    await expect(controller.syncNow()).resolves.toBeNull();
    expect(sent).toEqual([]);
    expect(controller.getState().status).toBe('offline');
  });

  it('keeps a rerun requested during an offline stop', async () => {
    const { queue } = createQueue();
    queue.enqueue({ ownerId: OWNER, kind: 'a', path: '/v1/a' });
    queue.enqueue({ ownerId: OWNER, kind: 'b', path: '/v1/b' });
    let blip = false;
    const connectivity: ConnectivitySource = {
      isOnline: () => {
        if (!blip) return true;
        blip = false;
        return false;
      },
      subscribe: () => () => undefined,
    };
    const sent: string[] = [];
    let controller: SyncController | null = null;
    const api: Pick<ApiClient, 'send'> = {
      send: (_method, path) => {
        sent.push(path);
        if (sent.length === 1) {
          blip = true;
          void controller?.syncNow();
        }
        return Promise.resolve({ status: 201, headers: new Headers(), body: null });
      },
    };
    controller = new SyncController({ queue, api, getOwnerId: owner, connectivity });

    await controller.syncNow();

    expect(sent).toEqual(['/v1/a', '/v1/b']);
    expect(queue.size).toBe(0);
  });

  it('ends a failed run in a consistent state and reports the error', async () => {
    const { queue } = createQueue();
    queue.enqueue({ ownerId: OWNER, kind: 'a', path: '/v1/a' });
    const errors: unknown[] = [];
    const failure = new Error('storage failure');
    const controller = new SyncController({
      queue,
      api: okApi().api,
      getOwnerId: () => Promise.reject(failure),
      connectivity: new FakeConnectivity(true),
      onError: (error) => errors.push(error),
    });

    await expect(controller.syncNow()).resolves.toBeNull();
    expect(errors).toEqual([failure]);
    expect(controller.getState()).toMatchObject({ status: 'idle', total: 0, processed: 0 });
  });

  it('surfaces auth-required when the session cannot be refreshed', async () => {
    const { queue } = createQueue();
    queue.enqueue({ ownerId: OWNER, kind: 'a', path: '/v1/a' });
    const { AuthRequiredError } = await import('../../infrastructure/api/errors');
    const api: Pick<ApiClient, 'send'> = { send: () => Promise.reject(new AuthRequiredError()) };
    const controller = new SyncController({
      queue,
      api,
      getOwnerId: owner,
      connectivity: new FakeConnectivity(true),
    });
    await controller.syncNow();
    expect(controller.getState()).toMatchObject({ status: 'auth-required', pending: 1 });
  });

  it('stops a running drain when the signed-in user changes', async () => {
    const { queue } = createQueue();
    queue.enqueue({ ownerId: OWNER, kind: 'a', path: '/v1/a' });
    queue.enqueue({ ownerId: OWNER, kind: 'b', path: '/v1/b' });
    let current: string | null = OWNER;
    const sent: string[] = [];
    const api: Pick<ApiClient, 'send'> = {
      send: (_method, path) => {
        sent.push(path);
        // The account is deleted / signed out while its first mutation is in flight.
        current = null;
        return Promise.resolve<ApiResponse>({ status: 201, headers: new Headers(), body: null });
      },
    };
    const controller = new SyncController({
      queue,
      api,
      getOwnerId: () => Promise.resolve(current),
      connectivity: new FakeConnectivity(true),
    });
    await controller.syncNow();
    expect(sent).toEqual(['/v1/a']);
    expect(queue.size).toBe(1);
  });
});
