/**
 * The member's own reservations: `GET /v1/reservations/me` and
 * `DELETE /v1/reservations/{reservationId}` (Requirements 7.4, 9.1 to 9.3).
 *
 * The schema reads only the fields the web screens use, so a list item
 * the API enriches later still parses. Cancellation closes two hours
 * before the class starts; the API enforces it (`cancellation_window_closed`)
 * and the screens hide the action once the window has closed.
 */
import { z } from 'zod';

import type { ApiClient } from './client';

/** Cancellation closes this long before the class starts (Requirement 9.2). */
export const CANCELLATION_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Longest class (480 min): a reservation that started this long ago may still be running. */
const MAX_CLASS_DURATION_MS = 480 * 60_000;

/** Page size requested from the API (its maximum). */
const PAGE_SIZE = 100;

/** Safety bound on the cursor pages followed in one load. */
export const MAX_RESERVATION_PAGES = 5;

export const MyReservationSchema = z.object({
  id: z.string().min(1),
  classId: z.string().min(1),
  status: z.enum(['confirmed', 'waitlist', 'cancelled', 'no_show']),
  class: z.object({
    title: z.string(),
    startsAt: z.string(),
    durationMin: z.number().int().positive(),
  }),
});

export type MyReservation = z.infer<typeof MyReservationSchema>;

const MyReservationsPageSchema = z.object({
  items: z.array(MyReservationSchema),
  nextCursor: z.string().nullable(),
});

/** Path of one page of the member's reservations whose class starts in `[from, to]`. */
export function myReservationsPath(
  range: { readonly from: Date; readonly to?: Date | undefined },
  cursor: string | null = null,
): string {
  const query = new URLSearchParams({ from: range.from.toISOString(), limit: String(PAGE_SIZE) });
  if (range.to !== undefined) query.set('to', range.to.toISOString());
  if (cursor !== null) query.set('cursor', cursor);
  return `/v1/reservations/me?${query.toString()}`;
}

export function cancelReservationPath(reservationId: string): string {
  return `/v1/reservations/${encodeURIComponent(reservationId)}`;
}

/** Lower bound that still includes a class of maximal length running at `now`. */
export function runningFrom(now: Date): Date {
  return new Date(now.getTime() - MAX_CLASS_DURATION_MS);
}

/** Every reservation in the range, following the cursor up to {@link MAX_RESERVATION_PAGES}. */
export async function fetchMyReservations(
  client: Pick<ApiClient, 'get'>,
  range: { readonly from: Date; readonly to?: Date | undefined },
): Promise<readonly MyReservation[]> {
  const items: MyReservation[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_RESERVATION_PAGES; page += 1) {
    const raw = await client.get<unknown>(myReservationsPath(range, cursor));
    const parsed = MyReservationsPageSchema.parse(raw);
    items.push(...parsed.items);
    cursor = parsed.nextCursor;
    if (cursor === null) break;
  }
  return items;
}

function isActive(item: MyReservation): boolean {
  return item.status === 'confirmed' || item.status === 'waitlist';
}

/** Active reservations whose class has not ended yet, soonest first. */
export function upcomingReservations(
  items: readonly MyReservation[],
  now: Date,
): readonly MyReservation[] {
  return items
    .filter(
      (item) =>
        isActive(item) &&
        Date.parse(item.class.startsAt) + item.class.durationMin * 60_000 > now.getTime(),
    )
    .sort((a, b) => Date.parse(a.class.startsAt) - Date.parse(b.class.startsAt));
}

/** Whether the member may still cancel: active and more than 2 h before the start. */
export function canCancel(item: MyReservation, now: Date): boolean {
  if (!isActive(item)) return false;
  return Date.parse(item.class.startsAt) - now.getTime() > CANCELLATION_WINDOW_MS;
}

/** The member's own place in a class, as the classes list shows it. */
export type MemberBooking =
  | {
      readonly kind: 'confirmed';
      /** Booking id when known: "Add to calendar" needs it to match the feed's UID. */
      readonly reservationId?: string | undefined;
    }
  | { readonly kind: 'waitlist'; readonly position?: number | undefined };

/** `classId → booking` for the active reservations among `items`. */
export function bookingsByClass(
  items: readonly MyReservation[],
): ReadonlyMap<string, MemberBooking> {
  const map = new Map<string, MemberBooking>();
  for (const item of items) {
    if (item.status === 'confirmed') {
      map.set(item.classId, { kind: 'confirmed', reservationId: item.id });
    } else if (item.status === 'waitlist') map.set(item.classId, { kind: 'waitlist' });
  }
  return map;
}
