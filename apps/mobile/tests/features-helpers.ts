import { randomUUID } from 'node:crypto';

import { vi, type Mock } from 'vitest';

import { createQueue, OWNER } from './helpers';

import type { WriteDeps } from '../features/writes';
import type { ApiClient } from '../infrastructure/api/client';
import type { SyncState, SyncStatus } from '../infrastructure/sync/sync-controller';

type ApiCall = Mock<(...args: unknown[]) => Promise<unknown>>;

export type FakeApi = Pick<ApiClient, 'get' | 'post' | 'put' | 'patch' | 'del'> & {
  readonly get: ApiCall;
  readonly post: ApiCall;
  readonly put: ApiCall;
  readonly patch: ApiCall;
  readonly del: ApiCall;
};

export function createFakeApi(): FakeApi {
  const call = (): ApiCall => vi.fn<(...args: unknown[]) => Promise<unknown>>();
  return { get: call(), post: call(), put: call(), patch: call(), del: call() } as FakeApi;
}

export function syncState(status: SyncStatus = 'idle'): SyncState {
  return { status, total: 0, processed: 0, pending: 0, deadLetters: 0, lastResult: null };
}

export function createFakeSync(status: SyncStatus = 'idle') {
  return {
    status,
    syncNow: vi.fn(() => Promise.resolve(null)),
    refreshOwner: vi.fn(() => Promise.resolve()),
    getState(): SyncState {
      return syncState(this.status);
    },
  };
}

export function createWriteDeps(options: { ownerId?: string | null; status?: SyncStatus } = {}) {
  const api = createFakeApi();
  const { queue } = createQueue();
  const sync = createFakeSync(options.status ?? 'idle');
  const ownerId = options.ownerId === undefined ? OWNER : options.ownerId;
  const deps: WriteDeps = {
    api,
    queue,
    sync,
    getOwnerId: () => Promise.resolve(ownerId),
    uuid: randomUUID,
  };
  return { deps, api, queue, sync };
}

/** Resolves after pending promise callbacks (fire-and-forget reloads) have run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export const CLASS_ID = '0b9a9c43-3a2c-4a11-9f41-8d2a2b0c1a01';
export const OTHER_CLASS_ID = '0b9a9c43-3a2c-4a11-9f41-8d2a2b0c1a02';
export const STUDIO_ID = '5c1d7e3a-9a0e-4b6b-8f0e-2f6f0a9d1b11';
export const USER_ID = '7f3e2d1c-0b9a-4c8d-9e7f-6a5b4c3d2e1f';
export const RESERVATION_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
