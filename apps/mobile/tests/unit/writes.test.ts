import { describe, expect, it } from 'vitest';

import { isAbortError, toErrorModel } from '../../features/errors';
import { submitWrite, toJsonPayload } from '../../features/writes';
import { ApiError, AuthRequiredError, NetworkError } from '../../infrastructure/api/errors';
import { isUuidV4 } from '../../infrastructure/ids';
import { createWriteDeps, flush } from '../features-helpers';
import { OWNER } from '../helpers';

const INPUT = {
  kind: 'bookClass',
  method: 'POST',
  path: '/v1/reservations',
  payload: { classId: 'c1' },
} as const;

describe('submitWrite', () => {
  it('sends online with a fresh UUID v4 idempotency key', async () => {
    const { deps, api, queue } = createWriteDeps();
    api.post.mockResolvedValue({ ok: true });

    const outcome = await submitWrite(deps, INPUT);

    expect(outcome).toEqual({ kind: 'sent', body: { ok: true } });
    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, body, options] = api.post.mock.calls[0] as [
      string,
      unknown,
      { idempotencyKey: string },
    ];
    expect(path).toBe('/v1/reservations');
    expect(body).toEqual({ classId: 'c1' });
    expect(isUuidV4(options.idempotencyKey)).toBe(true);
    expect(queue.size).toBe(0);
  });

  it('uses a different key for every write', async () => {
    const { deps, api } = createWriteDeps();
    api.post.mockResolvedValue({});
    await submitWrite(deps, INPUT);
    await submitWrite(deps, INPUT);
    const keys = api.post.mock.calls.map(
      (call) => (call[2] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(new Set(keys).size).toBe(2);
  });

  it('queues on NetworkError with the same idempotency key, then syncs', async () => {
    const { deps, api, queue, sync } = createWriteDeps();
    api.post.mockRejectedValue(new NetworkError('offline'));

    const outcome = await submitWrite(deps, INPUT);

    expect(outcome.kind).toBe('queued');
    const sentKey = (api.post.mock.calls[0]?.[2] as { idempotencyKey: string }).idempotencyKey;
    const [queued] = queue.peek();
    expect(queued).toMatchObject({
      ownerId: OWNER,
      kind: 'bookClass',
      method: 'POST',
      path: '/v1/reservations',
      payload: { classId: 'c1' },
      idempotencyKey: sentKey,
    });
    expect(sync.syncNow).toHaveBeenCalledTimes(1);
  });

  it('routes DELETE through del without a body', async () => {
    const { deps, api } = createWriteDeps();
    api.del.mockResolvedValue(null);
    await submitWrite(deps, {
      kind: 'cancelReservation',
      method: 'DELETE',
      path: '/v1/reservations/r1',
    });
    expect(api.del).toHaveBeenCalledWith('/v1/reservations/r1', expect.objectContaining({}));
  });

  it('queues straight away when the device is offline', async () => {
    const { deps, api, queue } = createWriteDeps({ status: 'offline' });
    const outcome = await submitWrite(deps, INPUT);
    expect(outcome.kind).toBe('queued');
    expect(api.post).not.toHaveBeenCalled();
    expect(queue.size).toBe(1);
  });

  it('queues behind older writes of the same user to keep FIFO order', async () => {
    const { deps, api, queue } = createWriteDeps();
    queue.enqueue({ ownerId: OWNER, kind: 'logSession', path: '/v1/sessions', payload: {} });

    const outcome = await submitWrite(deps, INPUT);

    expect(outcome.kind).toBe('queued');
    expect(api.post).not.toHaveBeenCalled();
    expect(queue.peek().map((item) => item.kind)).toEqual(['logSession', 'bookClass']);
  });

  it('ignores another account’s queued writes', async () => {
    const { deps, api, queue } = createWriteDeps();
    queue.enqueue({ ownerId: 'someone-else', kind: 'logSession', path: '/v1/sessions' });
    api.post.mockResolvedValue({});
    expect((await submitWrite(deps, INPUT)).kind).toBe('sent');
  });

  it('never queues a cancelled request', async () => {
    const { deps, api, queue } = createWriteDeps();
    const controller = new AbortController();
    api.post.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new NetworkError('aborted'));
    });

    await expect(submitWrite(deps, { ...INPUT, signal: controller.signal })).rejects.toThrow();
    expect(queue.size).toBe(0);
  });

  it('rejects a request cancelled before it starts without sending it', async () => {
    const { deps, api, queue } = createWriteDeps();
    const controller = new AbortController();
    controller.abort();
    const error: unknown = await submitWrite(deps, { ...INPUT, signal: controller.signal }).catch(
      (caught: unknown) => caught,
    );
    expect(isAbortError(error)).toBe(true);
    expect(api.post).not.toHaveBeenCalled();
    expect(queue.size).toBe(0);
  });

  it('rethrows API errors without queueing', async () => {
    const { deps, api, queue } = createWriteDeps();
    api.post.mockRejectedValue(new ApiError(422));
    await expect(submitWrite(deps, INPUT)).rejects.toBeInstanceOf(ApiError);
    expect(queue.size).toBe(0);
  });

  it('requires a signed-in user', async () => {
    const { deps } = createWriteDeps({ ownerId: null });
    await expect(submitWrite(deps, INPUT)).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('serializes a user’s writes: an older write that fails offline is queued first', async () => {
    const { deps, api, queue } = createWriteDeps();
    let failFirst: (error: unknown) => void = () => undefined;
    api.post.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        failFirst = reject;
      }),
    );
    api.post.mockResolvedValue({ ok: true });

    const first = submitWrite(deps, { ...INPUT, payload: { classId: 'older' } });
    const second = submitWrite(deps, { ...INPUT, payload: { classId: 'newer' } });
    await flush();
    // The newer write waits for the older one instead of going out alongside it.
    expect(api.post).toHaveBeenCalledTimes(1);

    failFirst(new NetworkError('offline'));
    expect((await first).kind).toBe('queued');
    expect((await second).kind).toBe('queued');
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(queue.peek().map((item) => item.payload)).toEqual([
      { classId: 'older' },
      { classId: 'newer' },
    ]);
  });

  it('keeps going after a write of the chain fails', async () => {
    const { deps, api } = createWriteDeps();
    api.post.mockRejectedValueOnce(new ApiError(422)).mockResolvedValueOnce({ ok: true });
    const first = submitWrite(deps, INPUT);
    const second = submitWrite(deps, INPUT);
    await expect(first).rejects.toBeInstanceOf(ApiError);
    expect(await second).toEqual({ kind: 'sent', body: { ok: true } });
  });

  it('does not make different users wait for each other', async () => {
    const shared = createWriteDeps();
    const other = { ...shared.deps, getOwnerId: () => Promise.resolve('user-2') };
    shared.api.post
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValueOnce({ ok: true });
    void submitWrite(shared.deps, INPUT);
    expect(await submitWrite(other, INPUT)).toEqual({ kind: 'sent', body: { ok: true } });
  });
});

describe('toJsonPayload', () => {
  it('drops undefined fields', () => {
    expect(toJsonPayload({ a: 1, b: undefined, c: [{ d: undefined, e: 2 }] })).toEqual({
      a: 1,
      c: [{ e: 2 }],
    });
  });
});

describe('toErrorModel', () => {
  it('maps the client errors to messages', () => {
    expect(toErrorModel(new AuthRequiredError())).toEqual({
      key: 'mobile.errors.sessionExpired',
      authRequired: true,
    });
    expect(toErrorModel(new NetworkError('x')).key).toBe('errors.network');
    expect(toErrorModel(new Error('x')).key).toBe('errors.generic');
  });

  it('prefers overrides, then the problem code, then the status', () => {
    const problem = { type: 'about:blank', title: 'x', status: 422, code: 'class_in_past' };
    expect(toErrorModel(new ApiError(422, problem)).key).toBe('errors.classInPast');
    expect(toErrorModel(new ApiError(422, { ...problem, code: 'unknown' })).key).toBe(
      'errors.validation',
    );
    // The override wins even over a known problem code.
    const coded401 = new ApiError(401, { ...problem, status: 401, code: 'rate_limit_exceeded' });
    expect(toErrorModel(coded401, { 401: 'auth.errors.invalidCredentials' }).key).toBe(
      'auth.errors.invalidCredentials',
    );
    expect(toErrorModel(coded401).key).toBe('errors.rateLimited');
    expect(toErrorModel(new ApiError(404)).key).toBe('errors.notFound');
    expect(toErrorModel(new ApiError(429)).key).toBe('errors.rateLimited');
    expect(toErrorModel(new ApiError(503)).key).toBe('errors.generic');
  });

  it('ignores problem codes that name inherited object properties', () => {
    for (const code of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const error = new ApiError(422, { type: 'about:blank', title: 'x', status: 422, code });
      expect(toErrorModel(error).key).toBe('errors.validation');
    }
  });
});
