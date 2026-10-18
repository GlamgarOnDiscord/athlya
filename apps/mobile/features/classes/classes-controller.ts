/**
 * Class list and booking — task 11.8, Requirements 8.1, 8.5 and 20.3.
 *
 * `book()` follows the optimistic mutation of design.md Example 1:
 * - onMutate: the class's `remaining` drops by one locally;
 * - onError: that decrement is undone (only if it happened, so a booking
 *   on a full class never "frees" a seat);
 * - onSettled: the list is fetched again from the API.
 * Online the booking is sent with a fresh `Idempotency-Key`; offline (or on
 * `NetworkError`) it is queued as `bookClass` with that same key, the
 * decrement is kept and the class shows as pending sync.
 */
import {
  BookingResponseSchema,
  ClassListResponseSchema,
  type ClassWithRemaining,
} from '@athlya/shared/schemas/api';

import { isAbortError, toErrorModel, type ErrorModel } from '../errors';
import { Store } from '../store';
import { submitWrite, type WriteDeps } from '../writes';

import type { ApiClient } from '../../infrastructure/api/client';
import type { PendingMutation } from '../../infrastructure/sync/queue';

export const BOOK_CLASS_KIND = 'bookClass';
export const RESERVATIONS_PATH = '/v1/reservations';

/** Days of upcoming classes listed (the API caps a range at 90 days). */
export const CLASS_WINDOW_DAYS = 14;

const DAY_MS = 86_400_000;

export type BookingMark =
  | { readonly kind: 'pending' }
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'waitlist'; readonly position: number }
  | { readonly kind: 'queued' };

export interface ClassesState {
  readonly load: 'idle' | 'loading' | 'ready' | 'error';
  readonly items: readonly ClassWithRemaining[];
  readonly error: ErrorModel | null;
  /** Booking state per class id, for this screen session. */
  readonly bookings: Readonly<Record<string, BookingMark>>;
  /** Outcome of the last booking, announced to the user. */
  readonly notice:
    | { readonly kind: 'error'; readonly error: ErrorModel }
    | { readonly kind: 'booked'; readonly mark: BookingMark }
    | null;
}

export interface ClassesDeps {
  readonly api: Pick<ApiClient, 'get'>;
  readonly writes: WriteDeps;
  readonly now?: () => Date;
}

const INITIAL: ClassesState = { load: 'idle', items: [], error: null, bookings: {}, notice: null };

export function classesPath(now: Date): string {
  const from = now.toISOString();
  const to = new Date(now.getTime() + CLASS_WINDOW_DAYS * DAY_MS).toISOString();
  return `/v1/classes?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

/** Class ids with a booking of `ownerId` still waiting in the offline queue. */
export function queuedBookingClassIds(pending: readonly PendingMutation[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const mutation of pending) {
    if (mutation.kind !== BOOK_CLASS_KIND) continue;
    const payload = mutation.payload;
    if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
      const classId = payload['classId'];
      if (typeof classId === 'string') ids.add(classId);
    }
  }
  return ids;
}

function adjustRemaining(
  items: readonly ClassWithRemaining[],
  classId: string,
  delta: number,
): readonly ClassWithRemaining[] {
  return items.map((item) =>
    item.id === classId
      ? { ...item, remaining: Math.min(item.capacity, Math.max(0, item.remaining + delta)) }
      : item,
  );
}

function withoutBooking(
  bookings: ClassesState['bookings'],
  classId: string,
): ClassesState['bookings'] {
  const next = { ...bookings };
  delete next[classId];
  return next;
}

export class ClassesController {
  readonly #deps: ClassesDeps;
  readonly #store = new Store<ClassesState>(INITIAL);
  #loadGeneration = 0;

  public constructor(deps: ClassesDeps) {
    this.#deps = deps;
  }

  public readonly get = (): ClassesState => this.#store.get();

  public readonly subscribe = (listener: () => void): (() => void) =>
    this.#store.subscribe(listener);

  #now(): Date {
    return this.#deps.now?.() ?? new Date();
  }

  /** Fetches the upcoming classes; a newer load supersedes an older one. */
  public async load(signal?: AbortSignal): Promise<void> {
    this.#loadGeneration += 1;
    const generation = this.#loadGeneration;
    this.#store.set((state) => ({ ...state, load: 'loading', error: null }));
    try {
      const raw = await this.#deps.api.get<unknown>(classesPath(this.#now()), {
        ...(signal === undefined ? {} : { signal }),
      });
      const { items } = ClassListResponseSchema.parse(raw);
      if (generation !== this.#loadGeneration) return;
      this.#store.set((state) => ({ ...state, load: 'ready', items, error: null }));
    } catch (error) {
      if (generation !== this.#loadGeneration || isAbortError(error)) return;
      this.#store.set((state) => ({ ...state, load: 'error', error: toErrorModel(error) }));
    }
  }

  public async book(classId: string): Promise<BookingMark | null> {
    const state = this.#store.get();
    const target = state.items.find((item) => item.id === classId);
    if (target === undefined || state.bookings[classId] !== undefined) return null;

    // onMutate: a load still in flight must not overwrite the optimistic count.
    this.#loadGeneration += 1;
    const decremented = target.remaining > 0;
    this.#store.set((current) => ({
      ...current,
      load: current.load === 'loading' ? 'ready' : current.load,
      items: decremented ? adjustRemaining(current.items, classId, -1) : current.items,
      bookings: { ...current.bookings, [classId]: { kind: 'pending' } },
      notice: null,
    }));

    let mark: BookingMark;
    try {
      const outcome = await submitWrite<unknown>(this.#deps.writes, {
        kind: BOOK_CLASS_KIND,
        method: 'POST',
        path: RESERVATIONS_PATH,
        payload: { classId },
      });
      if (outcome.kind === 'queued') {
        mark = { kind: 'queued' };
      } else {
        const booking = BookingResponseSchema.parse(outcome.body);
        mark =
          booking.status === 'confirmed'
            ? { kind: 'confirmed' }
            : { kind: 'waitlist', position: booking.position };
      }
    } catch (error) {
      // onError
      const model = toErrorModel(error, { 409: 'mobile.classes.alreadyBooked' });
      this.#store.set((current) => ({
        ...current,
        items: decremented ? adjustRemaining(current.items, classId, 1) : current.items,
        bookings: withoutBooking(current.bookings, classId),
        notice: { kind: 'error', error: model },
      }));
      if (!model.authRequired) void this.load();
      return null;
    }

    this.#store.set((current) => ({
      ...current,
      bookings: { ...current.bookings, [classId]: mark },
      notice: { kind: 'booked', mark },
    }));
    // onSettled: the server owns the seat count. A queued booking keeps its
    // optimistic decrement until the drain has sent it.
    if (mark.kind !== 'queued') void this.load();
    return mark;
  }
}
