/**
 * "My reservations": `GET /v1/reservations/me` and cancellation
 * (`DELETE /v1/reservations/{id}`, Requirements 9.1–9.3, 20.3).
 *
 * Cancelling is optimistic: the reservation shows as cancelled at once,
 * goes back to its previous status if the API refuses, and is queued as
 * `cancelReservation` with the same idempotency key when offline.
 */
import { ClassSchema, ReservationSchema } from '@athlya/shared/schemas/domain';
import { z } from 'zod';

import { isAbortError, toErrorModel, type ErrorModel } from '../errors';
import { Store } from '../store';
import { submitWrite, type WriteDeps } from '../writes';

import type { ApiClient } from '../../infrastructure/api/client';
import type { PendingMutation } from '../../infrastructure/sync/queue';

export const CANCEL_RESERVATION_KIND = 'cancelReservation';

/** Cancellation closes this long before the class starts (Requirement 9.2). */
export const CANCELLATION_WINDOW_MS = 2 * 60 * 60 * 1000;

/** One row of `GET /v1/reservations/me`: the reservation plus its class. */
export const MyReservationSchema = ReservationSchema.extend({
  class: ClassSchema.pick({ id: true, title: true, startsAt: true, durationMin: true }),
});

export const MyReservationsResponseSchema = z
  .object({
    items: z.array(MyReservationSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type MyReservation = z.infer<typeof MyReservationSchema>;

export const MY_RESERVATIONS_PATH = '/v1/reservations/me?limit=100';

export function cancelPath(reservationId: string): string {
  return `/v1/reservations/${encodeURIComponent(reservationId)}`;
}

/** Reservations whose class has not ended yet, soonest first. */
export function upcomingReservations(
  items: readonly MyReservation[],
  now: Date,
): readonly MyReservation[] {
  return items
    .filter(
      (item) =>
        new Date(item.class.startsAt).getTime() + item.class.durationMin * 60_000 > now.getTime(),
    )
    .sort((a, b) => Date.parse(a.class.startsAt) - Date.parse(b.class.startsAt));
}

/** Whether the member may still cancel: active and more than 2 h before the start. */
export function canCancel(item: MyReservation, now: Date): boolean {
  if (item.status !== 'confirmed' && item.status !== 'waitlist') return false;
  return new Date(item.class.startsAt).getTime() - now.getTime() > CANCELLATION_WINDOW_MS;
}

/** Reservation ids with a cancellation still waiting in the offline queue. */
export function queuedCancellationIds(pending: readonly PendingMutation[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const mutation of pending) {
    if (mutation.kind !== CANCEL_RESERVATION_KIND) continue;
    const prefix = '/v1/reservations/';
    if (!mutation.path.startsWith(prefix)) continue;
    try {
      const id = decodeURIComponent(mutation.path.slice(prefix.length));
      if (id !== '') ids.add(id);
    } catch {
      // A malformed path cannot name one of the listed reservations.
    }
  }
  return ids;
}

export interface ReservationsState {
  readonly load: 'idle' | 'loading' | 'ready' | 'error';
  readonly items: readonly MyReservation[];
  readonly error: ErrorModel | null;
  /** Reservation ids with a cancellation in flight. */
  readonly cancelling: ReadonlySet<string>;
  readonly notice:
    | { readonly kind: 'error'; readonly error: ErrorModel }
    | { readonly kind: 'cancelled' | 'queued' }
    | null;
}

export interface ReservationsDeps {
  readonly api: Pick<ApiClient, 'get'>;
  readonly writes: WriteDeps;
}

const INITIAL: ReservationsState = {
  load: 'idle',
  items: [],
  error: null,
  cancelling: new Set(),
  notice: null,
};

function setStatus(
  items: readonly MyReservation[],
  id: string,
  status: MyReservation['status'],
): readonly MyReservation[] {
  return items.map((item) => (item.id === id ? { ...item, status } : item));
}

function without(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  next.delete(id);
  return next;
}

export class ReservationsController {
  readonly #deps: ReservationsDeps;
  readonly #store = new Store<ReservationsState>(INITIAL);
  #loadGeneration = 0;

  public constructor(deps: ReservationsDeps) {
    this.#deps = deps;
  }

  public readonly get = (): ReservationsState => this.#store.get();

  public readonly subscribe = (listener: () => void): (() => void) =>
    this.#store.subscribe(listener);

  public async load(signal?: AbortSignal): Promise<void> {
    this.#loadGeneration += 1;
    const generation = this.#loadGeneration;
    this.#store.set((state) => ({ ...state, load: 'loading', error: null }));
    try {
      const raw = await this.#deps.api.get<unknown>(MY_RESERVATIONS_PATH, {
        ...(signal === undefined ? {} : { signal }),
      });
      const { items } = MyReservationsResponseSchema.parse(raw);
      if (generation !== this.#loadGeneration) return;
      this.#store.set((state) => ({ ...state, load: 'ready', items, error: null }));
    } catch (error) {
      if (generation !== this.#loadGeneration || isAbortError(error)) return;
      this.#store.set((state) => ({ ...state, load: 'error', error: toErrorModel(error) }));
    }
  }

  public async cancel(reservationId: string): Promise<boolean> {
    const state = this.#store.get();
    const target = state.items.find((item) => item.id === reservationId);
    if (target === undefined || state.cancelling.has(reservationId)) return false;

    const previous = target.status;
    this.#loadGeneration += 1;
    this.#store.set((current) => ({
      ...current,
      load: current.load === 'loading' ? 'ready' : current.load,
      items: setStatus(current.items, reservationId, 'cancelled'),
      cancelling: new Set([...current.cancelling, reservationId]),
      notice: null,
    }));

    try {
      const outcome = await submitWrite<unknown>(this.#deps.writes, {
        kind: CANCEL_RESERVATION_KIND,
        method: 'DELETE',
        path: cancelPath(reservationId),
      });
      this.#store.set((current) => ({
        ...current,
        cancelling: without(current.cancelling, reservationId),
        notice: { kind: outcome.kind === 'queued' ? 'queued' : 'cancelled' },
      }));
      if (outcome.kind === 'sent') void this.load();
      return true;
    } catch (error) {
      const model = toErrorModel(error);
      this.#store.set((current) => ({
        ...current,
        items: setStatus(current.items, reservationId, previous),
        cancelling: without(current.cancelling, reservationId),
        notice: { kind: 'error', error: model },
      }));
      return false;
    }
  }
}
