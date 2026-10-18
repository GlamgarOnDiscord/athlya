import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_WINDOW,
  progressionPath,
  ProgressionController,
  selectedExercise,
} from '../../features/progression/progression-controller';
import { createApiClient, type ApiClient, type ApiResponse } from '../../infrastructure/api/client';
import { AuthRequiredError, NetworkError } from '../../infrastructure/api/errors';
import { flush } from '../features-helpers';

import type { ProgressionResponse, ProgressionWindow } from '@athlya/shared/schemas/api';

function body(windowDays: ProgressionWindow = 90, volumeKg = 1200): ProgressionResponse {
  return {
    windowDays,
    from: '2026-07-21T00:00:00.000Z',
    to: '2026-10-19T00:00:00.000Z',
    totals: { sessions: 2, volumeKg },
    exercises: [
      {
        key: 'squat',
        name: 'Squat',
        sessionCount: 2,
        totalVolumeKg: volumeKg,
        bestEstimatedOneRepMaxKg: 100,
        points: [
          { date: '2026-10-01', volumeKg: 500, estimatedOneRepMaxKg: 90 },
          { date: '2026-10-08', volumeKg: volumeKg - 500, estimatedOneRepMaxKg: 100 },
        ],
      },
      {
        key: 'plank',
        name: 'Plank',
        sessionCount: 1,
        totalVolumeKg: 0,
        bestEstimatedOneRepMaxKg: null,
        points: [{ date: '2026-10-08', volumeKg: 0, estimatedOneRepMaxKg: null }],
      },
    ],
    weeklyFrequency: [
      { weekStart: '2026-09-28', sessions: 1 },
      { weekStart: '2026-10-05', sessions: 1 },
    ],
    truncated: false,
    skippedSessions: 0,
  };
}

function response(status: number, payload: unknown = null, etag?: string): ApiResponse {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (etag !== undefined) headers.set('etag', etag);
  return { status, headers, body: payload };
}

type SendArgs = Parameters<ApiClient['send']>;

function fakeSend() {
  return vi.fn<(...args: SendArgs) => Promise<ApiResponse>>();
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('progressionPath', () => {
  it('asks for the window in days', () => {
    expect(progressionPath(30)).toBe('/v1/me/progression?window=30');
    expect(progressionPath(365)).toBe('/v1/me/progression?window=365');
    expect(DEFAULT_WINDOW).toBe(90);
  });
});

describe('selectedExercise', () => {
  it('charts the picked exercise, else the most trained one', () => {
    const data = body();
    expect(selectedExercise(data, 'plank')?.name).toBe('Plank');
    expect(selectedExercise(data, null)?.name).toBe('Squat');
    expect(selectedExercise(data, 'gone')?.name).toBe('Squat');
    expect(selectedExercise({ ...data, exercises: [] }, null)).toBeUndefined();
  });
});

describe('ProgressionController', () => {
  it('fetches the default window and validates the body', async () => {
    const send = fakeSend().mockResolvedValue(response(200, body(), '"v1"'));
    const controller = new ProgressionController({ send });
    await controller.load();

    const [method, path, payload, options] = send.mock.calls[0] ?? [];
    expect([method, path, payload]).toEqual(['GET', '/v1/me/progression?window=90', undefined]);
    expect(options?.headers).toBeUndefined();
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(controller.get()).toMatchObject({ load: 'ready', windowDays: 90, error: null });
    expect(controller.get().data?.totals.sessions).toBe(2);
  });

  it('revalidates with If-None-Match and keeps the cached body on 304', async () => {
    const send = fakeSend()
      .mockResolvedValueOnce(response(200, body(), '"v1"'))
      .mockResolvedValueOnce(response(304, null, '"v1"'));
    const controller = new ProgressionController({ send });
    await controller.load();
    const first = controller.get().data;
    await controller.load();

    expect(send.mock.calls[1]?.[3]?.headers).toEqual({ 'If-None-Match': '"v1"' });
    expect(controller.get()).toMatchObject({ load: 'ready', error: null });
    expect(controller.get().data).toBe(first);
  });

  it('replaces the cached body and ETag when the data changed', async () => {
    const send = fakeSend()
      .mockResolvedValueOnce(response(200, body(90, 1200), '"v1"'))
      .mockResolvedValueOnce(response(200, body(90, 1500), '"v2"'))
      .mockResolvedValueOnce(response(304));
    const controller = new ProgressionController({ send });
    await controller.load();
    await controller.load();
    expect(controller.get().data?.totals.volumeKg).toBe(1500);
    await controller.load();
    expect(send.mock.calls[2]?.[3]?.headers).toEqual({ 'If-None-Match': '"v2"' });
    expect(controller.get().data?.totals.volumeKg).toBe(1500);
  });

  it('does not revalidate a body that came without an ETag', async () => {
    const send = fakeSend().mockResolvedValue(response(200, body()));
    const controller = new ProgressionController({ send });
    await controller.load();
    await controller.load();
    expect(send.mock.calls[1]?.[3]?.headers).toBeUndefined();
  });

  it('caches each window separately and shows the cached one while it reloads', async () => {
    const send = fakeSend()
      .mockResolvedValueOnce(response(200, body(90), '"w90"'))
      .mockResolvedValueOnce(response(200, body(30), '"w30"'));
    const controller = new ProgressionController({ send });
    await controller.load();
    await controller.selectWindow(30);
    expect(send.mock.calls[1]?.[1]).toBe('/v1/me/progression?window=30');
    expect(send.mock.calls[1]?.[3]?.headers).toBeUndefined();
    expect(controller.get().data?.windowDays).toBe(30);

    const pending = deferred<ApiResponse>();
    send.mockReturnValueOnce(pending.promise);
    const switching = controller.selectWindow(90);
    expect(controller.get()).toMatchObject({ load: 'loading', windowDays: 90 });
    expect(controller.get().data?.windowDays).toBe(90);
    expect(send.mock.calls[2]?.[3]?.headers).toEqual({ 'If-None-Match': '"w90"' });
    pending.resolve(response(304));
    await switching;
    expect(controller.get()).toMatchObject({ load: 'ready', windowDays: 90 });
  });

  it('keeps the picked exercise across reloads', async () => {
    const send = fakeSend().mockResolvedValue(response(200, body(), '"v1"'));
    const controller = new ProgressionController({ send });
    await controller.load();
    controller.selectExercise('plank');
    await controller.load();
    expect(controller.get().exerciseKey).toBe('plank');
  });

  it('rejects an invalid body, a 304 without a cached body and a mismatched window', async () => {
    const send = fakeSend()
      .mockResolvedValueOnce(response(200, { ...body(), totals: { sessions: -1, volumeKg: 0 } }))
      .mockResolvedValueOnce(response(304))
      .mockResolvedValueOnce(response(200, body(365), '"v1"'));
    const controller = new ProgressionController({ send });
    for (let i = 0; i < 3; i += 1) {
      await controller.load();
      expect(controller.get()).toMatchObject({
        load: 'error',
        data: null,
        error: { key: 'errors.generic', authRequired: false },
      });
    }
  });

  it('maps API, network and auth failures to error models', async () => {
    const send = fakeSend()
      .mockResolvedValueOnce(response(429, { type: 'about:blank', title: 'Too many', status: 429 }))
      .mockRejectedValueOnce(new NetworkError('offline'))
      .mockRejectedValueOnce(new AuthRequiredError());
    const controller = new ProgressionController({ send });

    await controller.load();
    expect(controller.get().error).toEqual({ key: 'errors.rateLimited', authRequired: false });
    await controller.load();
    expect(controller.get().error).toEqual({ key: 'errors.network', authRequired: false });
    await controller.load();
    expect(controller.get().error).toEqual({
      key: 'mobile.errors.sessionExpired',
      authRequired: true,
    });
  });

  it('keeps the last body on screen when a revalidation fails', async () => {
    const send = fakeSend()
      .mockResolvedValueOnce(response(200, body(), '"v1"'))
      .mockRejectedValueOnce(new NetworkError('offline'));
    const controller = new ProgressionController({ send });
    await controller.load();
    await controller.load();
    expect(controller.get()).toMatchObject({ load: 'error' });
    expect(controller.get().data?.totals.sessions).toBe(2);
  });

  it('forwards the caller’s abort and leaves the state untouched', async () => {
    const send = fakeSend().mockImplementation((_m, _p, _b, options) => {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(abortError());
        });
      });
    });
    const controller = new ProgressionController({ send });
    const abort = new AbortController();
    const loading = controller.load(abort.signal);
    abort.abort();
    await loading;
    expect(controller.get()).toMatchObject({ load: 'loading', error: null, data: null });
  });

  it('does not send anything useful when the signal is already aborted', async () => {
    const send = fakeSend().mockImplementation((_m, _p, _b, options) =>
      options?.signal?.aborted === true
        ? Promise.reject(abortError())
        : Promise.resolve(response(200, body())),
    );
    const controller = new ProgressionController({ send });
    const abort = new AbortController();
    abort.abort();
    await controller.load(abort.signal);
    expect(controller.get().data).toBeNull();
    expect(controller.get().error).toBeNull();
  });

  it('cancel() aborts the load in flight and ignores its answer', async () => {
    const slow = deferred<ApiResponse>();
    let signal: AbortSignal | undefined;
    const send = fakeSend().mockImplementationOnce((_m, _p, _b, options) => {
      signal = options?.signal;
      return slow.promise;
    });
    const controller = new ProgressionController({ send });
    const loading = controller.selectWindow(30);
    controller.cancel();
    expect(signal?.aborted).toBe(true);
    slow.resolve(response(200, body(30), '"w30"'));
    await loading;
    expect(controller.get().data).toBeNull();
  });

  it('cancels the load a newer one supersedes and ignores its late answer', async () => {
    const slow = deferred<ApiResponse>();
    const signals: AbortSignal[] = [];
    const send = fakeSend()
      .mockImplementationOnce((_m, _p, _b, options) => {
        if (options?.signal !== undefined) signals.push(options.signal);
        return slow.promise;
      })
      .mockResolvedValueOnce(response(200, body(30), '"w30"'));
    const controller = new ProgressionController({ send });
    const first = controller.load();
    await controller.selectWindow(30);
    expect(signals[0]?.aborted).toBe(true);

    slow.resolve(response(200, body(90), '"w90"'));
    await first;
    await flush();
    expect(controller.get()).toMatchObject({ load: 'ready', windowDays: 30 });
    expect(controller.get().data?.windowDays).toBe(30);
  });

  it('round-trips the ETag through the real API client', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      const ifNoneMatch = (init?.headers as Record<string, string> | undefined)?.['If-None-Match'];
      if (ifNoneMatch === '"abc"') return Promise.resolve(new Response(null, { status: 304 }));
      return Promise.resolve(
        new Response(JSON.stringify(body()), {
          status: 200,
          headers: { 'content-type': 'application/json', etag: '"abc"' },
        }),
      );
    });
    const api = createApiClient({
      baseUrl: 'https://api.athlya.test',
      tokens: { getAccessToken: () => 'token' },
      fetchImpl,
    });
    const controller = new ProgressionController(api);
    await controller.load();
    await controller.load();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(controller.get()).toMatchObject({ load: 'ready', error: null });
    expect(controller.get().data?.exercises).toHaveLength(2);
  });
});
