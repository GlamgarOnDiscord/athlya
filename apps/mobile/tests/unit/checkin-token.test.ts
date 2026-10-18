import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHECKIN_TOKEN_PATH,
  CheckinTokenController,
  NETWORK_RETRY_MS,
  RATE_LIMIT_RETRY_MS,
  REFRESH_MARGIN_MS,
} from '../../features/checkin/checkin-token';
import { toErrorModel } from '../../features/errors';
import { ApiError, AuthRequiredError, NetworkError } from '../../infrastructure/api/errors';
import { createFakeApi } from '../features-helpers';

/** Settles pending promise callbacks; `setTimeout(0)` is faked here, so it advances the fake clock by 0. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(0);
}

const T0 = Date.parse('2026-10-18T10:00:00.000Z');
const TTL_MS = 120_000;

function issued(at: number, token = `token-${String(at)}`) {
  return { token, expiresAt: new Date(at + TTL_MS).toISOString() };
}

function setup(options: { online?: boolean } = {}) {
  const api = createFakeApi();
  let online = options.online ?? true;
  const controller = new CheckinTokenController({ api, isOnline: () => online });
  return {
    api,
    controller,
    setOnline: (next: boolean): void => {
      online = next;
      controller.setOnline(next);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CheckinTokenController', () => {
  it('fetches a token on start with an empty body and shows the countdown', async () => {
    const { api, controller } = setup();
    api.post.mockResolvedValueOnce(issued(T0));

    controller.start();
    expect(controller.get().status).toBe('loading');
    await flush();

    expect(api.post).toHaveBeenCalledWith(CHECKIN_TOKEN_PATH, {}, expect.anything());
    expect(controller.get()).toMatchObject({
      status: 'ready',
      token: `token-${String(T0)}`,
      secondsLeft: 120,
      error: null,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(controller.get().secondsLeft).toBe(90);
    controller.stop();
  });

  it('fetches the next token REFRESH_MARGIN_MS before the current one expires', async () => {
    const { api, controller } = setup();
    api.post.mockResolvedValueOnce(issued(T0));
    const second = T0 + TTL_MS - REFRESH_MARGIN_MS;
    api.post.mockResolvedValueOnce(issued(second, 'second'));

    controller.start();
    await flush();
    await vi.advanceTimersByTimeAsync(TTL_MS - REFRESH_MARGIN_MS - 1);
    expect(api.post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();

    expect(api.post).toHaveBeenCalledTimes(2);
    expect(controller.get()).toMatchObject({ status: 'ready', token: 'second', secondsLeft: 120 });
    controller.stop();
  });

  it('pauses while stopped (background or blur) and resumes with a fresh token', async () => {
    const { api, controller } = setup();
    api.post.mockResolvedValue(issued(T0));

    controller.start();
    await flush();
    controller.stop();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(api.post).toHaveBeenCalledTimes(1);

    api.post.mockResolvedValueOnce(issued(Date.now(), 'resumed'));
    controller.start();
    expect(controller.get().token).toBeNull();
    await flush();
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(controller.get().token).toBe('resumed');
    controller.stop();
  });

  it('keeps a still-valid token when resumed and only schedules the refresh', async () => {
    const { api, controller } = setup();
    api.post.mockResolvedValueOnce(issued(T0));

    controller.start();
    await flush();
    controller.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    controller.start();

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(controller.get()).toMatchObject({ status: 'ready', secondsLeft: 100 });
    controller.stop();
  });

  it('aborts the request in flight when stopped', () => {
    const { api, controller } = setup();
    let signal: AbortSignal | undefined;
    api.post.mockImplementationOnce((...args: unknown[]) => {
      signal = (args[2] as { signal: AbortSignal }).signal;
      return new Promise(() => undefined);
    });

    controller.start();
    controller.stop();

    expect(signal?.aborted).toBe(true);
    expect(controller.get().status).toBe('idle');
  });

  it('never calls the API offline and fetches as soon as the device is back online', async () => {
    const { api, controller, setOnline } = setup({ online: false });

    controller.start();
    await flush();
    expect(api.post).not.toHaveBeenCalled();
    expect(controller.get().status).toBe('offline');

    api.post.mockResolvedValueOnce(issued(T0));
    setOnline(true);
    await flush();
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(controller.get().status).toBe('ready');
    controller.stop();
  });

  it('keeps showing a valid token offline, then says a connection is needed once it expires', async () => {
    const { api, controller, setOnline } = setup();
    api.post.mockResolvedValueOnce(issued(T0));

    controller.start();
    await flush();
    setOnline(false);
    expect(controller.get().status).toBe('ready');

    await vi.advanceTimersByTimeAsync(TTL_MS);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(controller.get()).toMatchObject({ status: 'offline', token: null, secondsLeft: 0 });
    controller.stop();
  });

  it('retries a network failure after NETWORK_RETRY_MS', async () => {
    const { api, controller } = setup();
    api.post.mockRejectedValueOnce(new NetworkError('offline'));
    api.post.mockResolvedValueOnce(issued(T0));

    controller.start();
    await flush();
    expect(controller.get()).toMatchObject({
      status: 'error',
      error: { key: 'errors.network', authRequired: false },
    });

    await vi.advanceTimersByTimeAsync(NETWORK_RETRY_MS);
    await flush();
    expect(controller.get().status).toBe('ready');
    controller.stop();
  });

  it('backs off for a minute on 429 and shows the check-in limit message', async () => {
    const { api, controller } = setup();
    api.post.mockRejectedValueOnce(
      new ApiError(429, {
        type: 'about:blank',
        title: 'Too Many Requests',
        status: 429,
        code: 'checkin_limit_reached',
      }),
    );
    api.post.mockResolvedValueOnce(issued(T0));

    controller.start();
    await flush();
    expect(controller.get().error).toEqual({
      key: 'mobile.checkin.limitReached',
      authRequired: false,
    });

    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS - 1);
    expect(api.post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(api.post).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it('stops on auth-required and does not retry, even when restarted', async () => {
    const { api, controller } = setup();
    api.post.mockRejectedValue(new AuthRequiredError());

    controller.start();
    await flush();
    expect(controller.get().error).toEqual({
      key: 'mobile.errors.sessionExpired',
      authRequired: true,
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    controller.stop();
    controller.start();
    await flush();
    expect(api.post).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('retry() fetches again after an error', async () => {
    const { api, controller } = setup();
    api.post.mockRejectedValueOnce(new ApiError(500));
    api.post.mockResolvedValueOnce(issued(T0));

    controller.start();
    await flush();
    expect(controller.get().status).toBe('error');

    controller.retry();
    await flush();
    expect(controller.get()).toMatchObject({ status: 'ready', error: null });
    controller.stop();
  });

  it('rejects a malformed response instead of rendering it', async () => {
    const { api, controller } = setup();
    api.post.mockResolvedValueOnce({ token: '' });

    controller.start();
    await flush();
    expect(controller.get()).toMatchObject({ status: 'error', token: null });
    controller.stop();
  });
});

describe('toErrorModel', () => {
  it('maps checkin_limit_reached to its own message', () => {
    expect(
      toErrorModel(
        new ApiError(429, {
          type: 'about:blank',
          title: 'Too Many Requests',
          status: 429,
          code: 'checkin_limit_reached',
        }),
      ),
    ).toEqual({ key: 'mobile.checkin.limitReached', authRequired: false });
  });
});
