import { describe, expect, it } from 'vitest';

import {
  CLASS_WINDOW_DAYS,
  ClassesController,
  classesPath,
  queuedBookingClassIds,
} from '../../features/classes/classes-controller';
import { ApiError, AuthRequiredError, NetworkError } from '../../infrastructure/api/errors';
import {
  CLASS_ID,
  createFakeApi,
  createWriteDeps,
  flush,
  OTHER_CLASS_ID,
  RESERVATION_ID,
  STUDIO_ID,
  USER_ID,
} from '../features-helpers';
import { OWNER } from '../helpers';

const NOW = new Date('2026-10-18T08:00:00.000Z');

function klass(id: string, remaining: number, capacity = 10) {
  return {
    id,
    studioId: STUDIO_ID,
    coachId: null,
    title: `Class ${id.slice(-2)}`,
    startsAt: '2026-10-20T17:00:00.000Z',
    durationMin: 60,
    capacity,
    version: 1,
    createdAt: '2026-10-01T10:00:00.000Z',
    remaining,
  };
}

function reservation(status: 'confirmed' | 'waitlist') {
  return {
    id: RESERVATION_ID,
    classId: CLASS_ID,
    userId: USER_ID,
    status,
    createdAt: '2026-10-18T08:00:00.000Z',
    cancelledAt: null,
    checkedInAt: null,
  };
}

async function setup(options: { remaining?: number; status?: 'idle' | 'offline' } = {}) {
  const writes = createWriteDeps({ status: options.status ?? 'idle' });
  const api = createFakeApi();
  api.get.mockResolvedValue({
    items: [klass(CLASS_ID, options.remaining ?? 3), klass(OTHER_CLASS_ID, 5)],
  });
  const controller = new ClassesController({ api, writes: writes.deps, now: () => NOW });
  await controller.load();
  api.get.mockClear();
  return { controller, api, writes };
}

function remainingOf(controller: ClassesController, id: string): number | undefined {
  return controller.get().items.find((item) => item.id === id)?.remaining;
}

describe('classesPath', () => {
  it('lists the next two weeks', () => {
    const path = classesPath(NOW);
    const url = new URL(path, 'https://api.test');
    expect(url.pathname).toBe('/v1/classes');
    expect(url.searchParams.get('from')).toBe(NOW.toISOString());
    expect(Date.parse(url.searchParams.get('to') ?? '') - NOW.getTime()).toBe(
      CLASS_WINDOW_DAYS * 86_400_000,
    );
  });
});

describe('ClassesController.load', () => {
  it('validates the listing with the shared schema', async () => {
    const { controller } = await setup();
    expect(controller.get()).toMatchObject({ load: 'ready', error: null });
    expect(controller.get().items).toHaveLength(2);
  });

  it('reports a malformed listing as an error', async () => {
    const api = createFakeApi();
    api.get.mockResolvedValue({ items: [{ id: 'nope' }] });
    const controller = new ClassesController({ api, writes: createWriteDeps().deps });
    await controller.load();
    expect(controller.get()).toMatchObject({ load: 'error', error: { key: 'errors.generic' } });
  });

  it('flags an expired session', async () => {
    const api = createFakeApi();
    api.get.mockRejectedValue(new AuthRequiredError());
    const controller = new ClassesController({ api, writes: createWriteDeps().deps });
    await controller.load();
    expect(controller.get().error).toEqual({
      key: 'mobile.errors.sessionExpired',
      authRequired: true,
    });
  });

  it('keeps only the latest of overlapping loads', async () => {
    const api = createFakeApi();
    let resolveSlow: (value: unknown) => void = () => undefined;
    api.get
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSlow = resolve;
        }),
      )
      .mockResolvedValueOnce({ items: [klass(CLASS_ID, 1)] });
    const controller = new ClassesController({ api, writes: createWriteDeps().deps });
    const slow = controller.load();
    await controller.load();
    resolveSlow({ items: [klass(CLASS_ID, 9)] });
    await slow;
    expect(remainingOf(controller, CLASS_ID)).toBe(1);
  });
});

describe('ClassesController.book (useBookClass)', () => {
  it('decrements optimistically, confirms, then refetches', async () => {
    const { controller, api, writes } = await setup();
    let resolveBooking: (value: unknown) => void = () => undefined;
    writes.api.post.mockReturnValue(
      new Promise((resolve) => {
        resolveBooking = resolve;
      }),
    );
    api.get.mockResolvedValue({ items: [klass(CLASS_ID, 2), klass(OTHER_CLASS_ID, 5)] });

    const booking = controller.book(CLASS_ID);
    await flush();
    expect(remainingOf(controller, CLASS_ID)).toBe(2);
    expect(controller.get().bookings[CLASS_ID]).toEqual({ kind: 'pending' });

    resolveBooking({ status: 'confirmed', reservation: reservation('confirmed') });
    expect(await booking).toEqual({ kind: 'confirmed' });
    await flush();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(controller.get().bookings[CLASS_ID]).toEqual({ kind: 'confirmed' });
    expect(controller.get().notice).toEqual({ kind: 'booked', mark: { kind: 'confirmed' } });
    expect(writes.api.post).toHaveBeenCalledWith(
      '/v1/reservations',
      { classId: CLASS_ID },
      expect.objectContaining({ idempotencyKey: expect.any(String) as string }),
    );
  });

  it('reports the waitlist position', async () => {
    const { controller, writes } = await setup({ remaining: 0 });
    writes.api.post.mockResolvedValue({
      status: 'waitlist',
      reservation: reservation('waitlist'),
      position: 4,
    });
    expect(await controller.book(CLASS_ID)).toEqual({ kind: 'waitlist', position: 4 });
  });

  it('rolls the decrement back on an API error and refetches', async () => {
    const { controller, api, writes } = await setup();
    writes.api.post.mockRejectedValue(
      new ApiError(422, { type: 'about:blank', title: 'x', status: 422, code: 'class_in_past' }),
    );
    expect(await controller.book(CLASS_ID)).toBeNull();
    expect(remainingOf(controller, CLASS_ID)).toBe(3);
    expect(controller.get().bookings[CLASS_ID]).toBeUndefined();
    expect(controller.get().notice).toEqual({
      kind: 'error',
      error: { key: 'errors.classInPast', authRequired: false },
    });
    await flush();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('maps 409 to "already booked"', async () => {
    const { controller, writes } = await setup();
    writes.api.post.mockRejectedValue(new ApiError(409));
    await controller.book(CLASS_ID);
    expect(controller.get().notice).toMatchObject({
      error: { key: 'mobile.classes.alreadyBooked' },
    });
  });

  it('never frees a seat when rolling back a booking on a full class', async () => {
    const { controller, writes } = await setup({ remaining: 0 });
    writes.api.post.mockRejectedValue(new ApiError(503));
    await controller.book(CLASS_ID);
    expect(remainingOf(controller, CLASS_ID)).toBe(0);
  });

  it('queues the booking on NetworkError, keeps the decrement and skips the refetch', async () => {
    const { controller, api, writes } = await setup();
    writes.api.post.mockRejectedValue(new NetworkError('offline'));

    expect(await controller.book(CLASS_ID)).toEqual({ kind: 'queued' });
    await flush();

    expect(remainingOf(controller, CLASS_ID)).toBe(2);
    expect(api.get).not.toHaveBeenCalled();
    const [queued] = writes.queue.peek();
    expect(queued).toMatchObject({
      kind: 'bookClass',
      path: '/v1/reservations',
      payload: { classId: CLASS_ID },
      ownerId: OWNER,
    });
    const sentKey = (writes.api.post.mock.calls[0]?.[2] as { idempotencyKey: string })
      .idempotencyKey;
    expect(queued?.idempotencyKey).toBe(sentKey);
    expect(writes.sync.syncNow).toHaveBeenCalled();
  });

  it('ignores a second tap while the first booking is pending', async () => {
    const { controller, writes } = await setup();
    writes.api.post.mockReturnValue(new Promise(() => undefined));
    void controller.book(CLASS_ID);
    await flush();
    expect(await controller.book(CLASS_ID)).toBeNull();
    expect(writes.api.post).toHaveBeenCalledTimes(1);
    expect(remainingOf(controller, CLASS_ID)).toBe(2);
  });

  it('does not let an in-flight load overwrite the optimistic count', async () => {
    const { controller, api, writes } = await setup();
    let resolveLoad: (value: unknown) => void = () => undefined;
    api.get.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const load = controller.load();
    writes.api.post.mockReturnValue(new Promise(() => undefined));
    void controller.book(CLASS_ID);
    resolveLoad({ items: [klass(CLASS_ID, 3), klass(OTHER_CLASS_ID, 5)] });
    await load;
    expect(remainingOf(controller, CLASS_ID)).toBe(2);
    expect(controller.get().load).toBe('ready');
  });
});

describe('queuedBookingClassIds', () => {
  it('collects the class ids of queued bookings only', () => {
    const { queue } = createWriteDeps();
    queue.enqueue({
      ownerId: OWNER,
      kind: 'bookClass',
      path: '/v1/reservations',
      payload: { classId: CLASS_ID },
    });
    queue.enqueue({
      ownerId: OWNER,
      kind: 'logSession',
      path: '/v1/sessions',
      payload: { classId: OTHER_CLASS_ID },
    });
    queue.enqueue({ ownerId: OWNER, kind: 'bookClass', path: '/v1/reservations', payload: null });
    expect([...queuedBookingClassIds(queue.pendingFor(OWNER))]).toEqual([CLASS_ID]);
  });
});
