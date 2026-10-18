import { describe, expect, it, vi } from 'vitest';

import { AuthRequiredError, NetworkError } from '../../infrastructure/api/errors';
import {
  backoffDelayMs,
  classifyStatus,
  drainMutationQueue,
  type DrainProgress,
} from '../../infrastructure/sync/drain';
import { createQueue, OWNER } from '../helpers';

import type { ApiClient, ApiResponse } from '../../infrastructure/api/client';

type Send = ApiClient['send'];

function respond(status: number, body: unknown = null): ApiResponse {
  return { status, headers: new Headers(), body };
}

function scriptedApi(script: (call: number, path: string) => ApiResponse | Error): {
  api: { send: Send };
  calls: { method: string; path: string; body: unknown; key: string | undefined }[];
} {
  const calls: { method: string; path: string; body: unknown; key: string | undefined }[] = [];
  const send: Send = (method, path, body, options) => {
    calls.push({ method, path, body, key: options?.idempotencyKey });
    const outcome = script(calls.length, path);
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  };
  return { api: { send }, calls };
}

const noSleep = () => Promise.resolve();

describe('classifyStatus', () => {
  it.each([
    [200, 'acknowledged'],
    [201, 'acknowledged'],
    [204, 'acknowledged'],
    [409, 'acknowledged'],
    [400, 'rejected'],
    [403, 'rejected'],
    [404, 'rejected'],
    [422, 'rejected'],
    [408, 'transient'],
    [429, 'transient'],
    [500, 'transient'],
    [503, 'transient'],
  ] as const)('%i → %s', (status, expected) => {
    expect(classifyStatus(status)).toBe(expected);
  });
});

describe('backoffDelayMs', () => {
  it('follows min(2^attempt × 1 s, 30 s) + jitter', () => {
    const noJitter = () => 0;
    expect([1, 2, 3, 4, 5].map((attempt) => backoffDelayMs(attempt, noJitter))).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000,
    ]);
    expect(backoffDelayMs(1, () => 0.5)).toBe(2_500);
    expect(backoffDelayMs(10, () => 0.999)).toBeLessThan(31_000);
  });
});

describe('drainMutationQueue (Algorithm 4)', () => {
  it('sends every mutation in FIFO order with its Idempotency-Key and removes acknowledged ones', async () => {
    const { queue } = createQueue();
    const a = queue.enqueue({
      ownerId: OWNER,
      kind: 'logSession',
      path: '/v1/sessions',
      payload: { n: 1 },
    });
    const b = queue.enqueue({
      ownerId: OWNER,
      kind: 'cancelReservation',
      method: 'DELETE',
      path: '/v1/reservations/r1',
    });
    const { api, calls } = scriptedApi((call) => respond(call === 1 ? 201 : 204));

    const result = await drainMutationQueue(queue, api, {
      ownerId: OWNER,
      isOnline: () => true,
      sleep: noSleep,
    });

    expect(calls).toEqual([
      { method: 'POST', path: '/v1/sessions', body: { n: 1 }, key: a.idempotencyKey },
      { method: 'DELETE', path: '/v1/reservations/r1', body: undefined, key: b.idempotencyKey },
    ]);
    expect(result).toEqual({
      acknowledged: 2,
      deadLettered: 0,
      remaining: 0,
      stoppedBy: 'completed',
    });
  });

  it('treats 409 as already applied', async () => {
    const { queue } = createQueue();
    queue.enqueue({ ownerId: OWNER, kind: 'bookClass', path: '/v1/reservations' });
    const { api } = scriptedApi(() => respond(409));
    const result = await drainMutationQueue(queue, api, {
      ownerId: OWNER,
      isOnline: () => true,
      sleep: noSleep,
    });
    expect(result.acknowledged).toBe(1);
    expect(queue.size).toBe(0);
    expect(queue.deadLetters()).toEqual([]);
  });

  it('dead-letters a permanent 4xx with its problem code and continues', async () => {
    const { queue } = createQueue();
    const a = queue.enqueue({ ownerId: OWNER, kind: 'bookClass', path: '/v1/reservations' });
    queue.enqueue({ ownerId: OWNER, kind: 'logSession', path: '/v1/sessions' });
    const { api, calls } = scriptedApi((call) =>
      call === 1
        ? respond(422, {
            type: 'about:blank',
            title: 'Invalid',
            status: 422,
            code: 'class_in_past',
          })
        : respond(201),
    );

    const result = await drainMutationQueue(queue, api, {
      ownerId: OWNER,
      isOnline: () => true,
      sleep: noSleep,
    });

    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ acknowledged: 1, deadLettered: 1, stoppedBy: 'completed' });
    expect(queue.deadLetters()).toEqual([
      expect.objectContaining({ id: a.id, status: 422, problemCode: 'class_in_past' }),
    ]);
  });

  it('retries 5xx and network errors with backoff, then succeeds', async () => {
    const { queue } = createQueue();
    queue.enqueue({ ownerId: OWNER, kind: 'logSession', path: '/v1/sessions' });
    const { api, calls } = scriptedApi((call) =>
      call === 1 ? respond(503) : call === 2 ? new NetworkError('offline') : respond(201),
    );
    const sleep = vi.fn((_ms: number) => Promise.resolve());

    const result = await drainMutationQueue(queue, api, {
      ownerId: OWNER,
      isOnline: () => true,
      sleep,
      random: () => 0,
    });

    expect(calls).toHaveLength(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2_000, 4_000]);
    const firstKey = calls[0]?.key;
    expect(firstKey).toBeDefined();
    expect(calls.every((c) => c.key === firstKey)).toBe(true);
    expect(result.stoppedBy).toBe('completed');
  });

  it('stops as offline when the network drops during a backoff', async () => {
    const { queue } = createQueue();
    queue.enqueue({ ownerId: OWNER, kind: 'a', path: '/v1/a' });
    let online = true;
    const { api, calls } = scriptedApi(() => respond(503));
    const result = await drainMutationQueue(queue, api, {
      ownerId: OWNER,
      isOnline: () => online,
      sleep: () => {
        online = false;
        return Promise.resolve();
      },
    });
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ remaining: 1, stoppedBy: 'offline' });
  });

  it("only sends the signed-in user's mutations and keeps the others in order", async () => {
    const { queue } = createQueue();
    const mine = queue.enqueue({ ownerId: OWNER, kind: 'a', path: '/v1/a' });
    const theirs = queue.enqueue({ ownerId: 'user-2', kind: 'b', path: '/v1/b' });
    const mineToo = queue.enqueue({ ownerId: OWNER, kind: 'c', path: '/v1/c' });
    const { api, calls } = scriptedApi(() => respond(201));

    const result = await drainMutationQueue(queue, api, {
      ownerId: OWNER,
      isOnline: () => true,
      sleep: noSleep,
    });

    expect(calls.map((c) => c.key)).toEqual([mine.idempotencyKey, mineToo.idempotencyKey]);
    expect(queue.peek().map((m) => m.id)).toEqual([theirs.id]);
    expect(result).toMatchObject({ acknowledged: 2, remaining: 1, stoppedBy: 'completed' });
  });

  it('sends nothing without a signed-in user', async () => {
    const { queue } = createQueue();
    queue.enqueue({ ownerId: OWNER, kind: 'a', path: '/v1/a' });
    const { api, calls } = scriptedApi(() => respond(201));
    const result = await drainMutationQueue(queue, api, {
      ownerId: null,
      isOnline: () => true,
      sleep: noSleep,
    });
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ remaining: 1, stoppedBy: 'auth-required' });
  });

  it('keeps a mutation after 5 failed attempts and stops so later ones cannot overtake it', async () => {
    const { queue } = createQueue();
    const a = queue.enqueue({ ownerId: OWNER, kind: 'a', path: '/v1/a' });
    const b = queue.enqueue({ ownerId: OWNER, kind: 'b', path: '/v1/b' });
    const { api, calls } = scriptedApi(() => respond(500));
    const sleep = vi.fn((_ms: number) => Promise.resolve());

    const result = await drainMutationQueue(queue, api, {
      ownerId: OWNER,
      isOnline: () => true,
      sleep,
      random: () => 0,
    });

    expect(calls.map((c) => c.path)).toEqual(Array<string>(5).fill('/v1/a'));
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(result).toEqual({
      acknowledged: 0,
      deadLettered: 0,
      remaining: 2,
      stoppedBy: 'retries-exhausted',
    });
    expect(queue.peek().map((m) => m.id)).toEqual([a.id, b.id]);
  });

  it('stops before the next mutation when the network drops', async () => {
    const { queue } = createQueue();
    queue.enqueue({ ownerId: OWNER, kind: 'a', path: '/v1/a' });
    queue.enqueue({ ownerId: OWNER, kind: 'b', path: '/v1/b' });
    let online = true;
    const { api, calls } = scriptedApi(() => {
      online = false;
      return respond(201);
    });

    const result = await drainMutationQueue(queue, api, {
      ownerId: OWNER,
      isOnline: () => online,
      sleep: noSleep,
    });

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ acknowledged: 1, remaining: 1, stoppedBy: 'offline' });
  });

  it('does nothing when offline from the start', async () => {
    const { queue } = createQueue();
    queue.enqueue({ ownerId: OWNER, kind: 'a', path: '/v1/a' });
    const { api, calls } = scriptedApi(() => respond(201));
    const result = await drainMutationQueue(queue, api, {
      ownerId: OWNER,
      isOnline: () => false,
      sleep: noSleep,
    });
    expect(calls).toHaveLength(0);
    expect(result.stoppedBy).toBe('offline');
  });

  it('stops without touching the queue when the session cannot be refreshed', async () => {
    const { queue } = createQueue();
    queue.enqueue({ ownerId: OWNER, kind: 'a', path: '/v1/a' });
    const { api } = scriptedApi(() => new AuthRequiredError());
    const result = await drainMutationQueue(queue, api, {
      ownerId: OWNER,
      isOnline: () => true,
      sleep: noSleep,
    });
    expect(result).toMatchObject({ remaining: 1, deadLettered: 0, stoppedBy: 'auth-required' });
  });

  it('reports progress for the UI', async () => {
    const { queue } = createQueue();
    queue.enqueue({ ownerId: OWNER, kind: 'a', path: '/v1/a' });
    queue.enqueue({ ownerId: OWNER, kind: 'b', path: '/v1/b' });
    const { api } = scriptedApi(() => respond(201));
    const progress: DrainProgress[] = [];

    await drainMutationQueue(queue, api, {
      ownerId: OWNER,
      isOnline: () => true,
      sleep: noSleep,
      onProgress: (p) => progress.push(p),
    });

    expect(progress.map((p) => [p.processed, p.total])).toEqual([
      [0, 2],
      [0, 2],
      [1, 2],
      [1, 2],
      [2, 2],
    ]);
  });
});
