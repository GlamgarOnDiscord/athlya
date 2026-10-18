import { describe, expect, it } from 'vitest';

import {
  cancelPath,
  canCancel,
  MAX_RESERVATION_PAGES,
  myReservationsPath,
  MyReservationSchema,
  queuedCancellationIds,
  ReservationsController,
  upcomingReservations,
  type MyReservation,
} from '../../features/reservations/reservations-controller';
import { ApiError, NetworkError } from '../../infrastructure/api/errors';
import {
  CLASS_ID,
  createFakeApi,
  createWriteDeps,
  flush,
  RESERVATION_ID,
  USER_ID,
} from '../features-helpers';
import { OWNER } from '../helpers';

const NOW = new Date('2026-10-18T08:00:00.000Z');
const OTHER_ID = 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5e';

function row(
  id: string,
  startsAt: string,
  status: MyReservation['status'] = 'confirmed',
): MyReservation {
  return MyReservationSchema.parse({
    id,
    classId: CLASS_ID,
    userId: USER_ID,
    status,
    createdAt: '2026-10-10T08:00:00.000Z',
    cancelledAt: null,
    checkedInAt: null,
    class: { id: CLASS_ID, title: 'Yoga', startsAt, durationMin: 60 },
  });
}

async function setup(items: MyReservation[] = [row(RESERVATION_ID, '2026-10-20T17:00:00.000Z')]) {
  const writes = createWriteDeps();
  const api = createFakeApi();
  api.get.mockResolvedValue({ items, nextCursor: null });
  const controller = new ReservationsController({ api, writes: writes.deps });
  await controller.load();
  api.get.mockClear();
  return { controller, api, writes };
}

describe('reservation helpers', () => {
  it('keeps upcoming reservations, soonest first', () => {
    const later = row(OTHER_ID, '2026-10-22T17:00:00.000Z');
    const sooner = row(RESERVATION_ID, '2026-10-19T17:00:00.000Z');
    const ended = row('c1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5f', '2026-10-18T06:30:00.000Z');
    const ongoing = row('d1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c50', '2026-10-18T07:30:00.000Z');
    expect(upcomingReservations([later, ended, sooner, ongoing], NOW).map((r) => r.id)).toEqual([
      ongoing.id,
      sooner.id,
      later.id,
    ]);
  });

  it('allows cancellation only for active reservations more than 2 h ahead', () => {
    expect(canCancel(row(RESERVATION_ID, '2026-10-18T10:01:00.000Z'), NOW)).toBe(true);
    expect(canCancel(row(RESERVATION_ID, '2026-10-18T10:00:00.000Z'), NOW)).toBe(false);
    expect(canCancel(row(RESERVATION_ID, '2026-10-20T10:00:00.000Z', 'waitlist'), NOW)).toBe(true);
    expect(canCancel(row(RESERVATION_ID, '2026-10-20T10:00:00.000Z', 'cancelled'), NOW)).toBe(
      false,
    );
  });

  it('finds queued cancellations by path', () => {
    const { queue } = createWriteDeps();
    queue.enqueue({
      ownerId: OWNER,
      kind: 'cancelReservation',
      method: 'DELETE',
      path: cancelPath(RESERVATION_ID),
    });
    queue.enqueue({ ownerId: OWNER, kind: 'bookClass', path: '/v1/reservations' });
    expect([...queuedCancellationIds(queue.pendingFor(OWNER))]).toEqual([RESERVATION_ID]);
  });
});

describe('ReservationsController', () => {
  it('loads and validates GET /v1/reservations/me', async () => {
    const writes = createWriteDeps();
    const api = createFakeApi();
    api.get.mockResolvedValue({
      items: [row(RESERVATION_ID, '2026-10-20T17:00:00.000Z')],
      nextCursor: null,
    });
    const controller = new ReservationsController({ api, writes: writes.deps, now: () => NOW });
    await controller.load();
    expect(api.get).toHaveBeenCalledWith(myReservationsPath(NOW), {});
    expect(controller.get()).toMatchObject({ load: 'ready', items: [{ id: RESERVATION_ID }] });
  });

  it('asks only for classes that may not have ended, and follows the cursor', async () => {
    const url = new URL(myReservationsPath(NOW, 'c+1'), 'https://api.test');
    expect(url.searchParams.get('from')).toBe('2026-10-18T00:00:00.000Z');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('cursor')).toBe('c+1');

    const writes = createWriteDeps();
    const api = createFakeApi();
    api.get
      .mockResolvedValueOnce({
        items: [row(RESERVATION_ID, '2026-10-20T17:00:00.000Z')],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        items: [row(OTHER_ID, '2026-10-21T17:00:00.000Z')],
        nextCursor: null,
      });
    const controller = new ReservationsController({ api, writes: writes.deps, now: () => NOW });
    await controller.load();
    expect(api.get).toHaveBeenNthCalledWith(2, myReservationsPath(NOW, 'page-2'), {});
    expect(controller.get().items.map((item) => item.id)).toEqual([RESERVATION_ID, OTHER_ID]);
  });

  it('stops after the page bound', async () => {
    const writes = createWriteDeps();
    const api = createFakeApi();
    api.get.mockResolvedValue({ items: [], nextCursor: 'again' });
    const controller = new ReservationsController({ api, writes: writes.deps });
    await controller.load();
    expect(api.get).toHaveBeenCalledTimes(MAX_RESERVATION_PAGES);
    expect(controller.get().load).toBe('ready');
  });

  it('refetches once a queued cancellation leaves the queue (delivered or rejected)', async () => {
    const { controller, api } = await setup();
    api.get.mockResolvedValue({ items: [], nextCursor: null });
    controller.reconcileQueued(new Set([RESERVATION_ID]));
    expect(api.get).not.toHaveBeenCalled();
    controller.reconcileQueued(new Set([RESERVATION_ID]));
    expect(api.get).not.toHaveBeenCalled();
    controller.reconcileQueued(new Set());
    await flush();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('rejects rows with unexpected fields', async () => {
    const writes = createWriteDeps();
    const api = createFakeApi();
    api.get.mockResolvedValue({
      items: [{ ...row(RESERVATION_ID, '2026-10-20T17:00:00.000Z'), extra: true }],
      nextCursor: null,
    });
    const controller = new ReservationsController({ api, writes: writes.deps });
    await controller.load();
    expect(controller.get().load).toBe('error');
  });

  it('cancels optimistically and refetches', async () => {
    const { controller, api, writes } = await setup();
    writes.api.del.mockResolvedValue({ status: 'cancelled' });
    api.get.mockResolvedValue({ items: [], nextCursor: null });

    expect(await controller.cancel(RESERVATION_ID)).toBe(true);
    expect(writes.api.del).toHaveBeenCalledWith(
      cancelPath(RESERVATION_ID),
      expect.objectContaining({ idempotencyKey: expect.any(String) as string }),
    );
    expect(controller.get().notice).toEqual({ kind: 'cancelled' });
    await flush();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('restores the previous status when the API refuses', async () => {
    const { controller, writes } = await setup([
      row(RESERVATION_ID, '2026-10-20T17:00:00.000Z', 'waitlist'),
    ]);
    writes.api.del.mockRejectedValue(
      new ApiError(422, {
        type: 'about:blank',
        title: 'x',
        status: 422,
        code: 'cancellation_window_closed',
      }),
    );
    expect(await controller.cancel(RESERVATION_ID)).toBe(false);
    expect(controller.get().items[0]?.status).toBe('waitlist');
    expect(controller.get().notice).toMatchObject({ error: { key: 'errors.cancelWindowClosed' } });
    expect(controller.get().cancelling.size).toBe(0);
  });

  it('queues the cancellation when offline', async () => {
    const { controller, writes } = await setup();
    writes.api.del.mockRejectedValue(new NetworkError('offline'));
    expect(await controller.cancel(RESERVATION_ID)).toBe(true);
    expect(controller.get().notice).toEqual({ kind: 'queued' });
    expect(controller.get().items[0]?.status).toBe('cancelled');
    expect(writes.queue.peek()[0]).toMatchObject({
      kind: 'cancelReservation',
      method: 'DELETE',
      path: cancelPath(RESERVATION_ID),
    });
  });

  it('ignores unknown or already-cancelling reservations', async () => {
    const { controller, writes } = await setup();
    writes.api.del.mockReturnValue(new Promise(() => undefined));
    expect(await controller.cancel('unknown')).toBe(false);
    void controller.cancel(RESERVATION_ID);
    await flush();
    expect(await controller.cancel(RESERVATION_ID)).toBe(false);
    expect(writes.api.del).toHaveBeenCalledTimes(1);
  });
});
