/**
 * Pure helpers behind the member file page: how a reservation reads in
 * the member's history and in the coming bookings.
 */
import type { MemberFileReservation } from '@athlya/shared/schemas/api';

export type ReservationOutcome =
  'attended' | 'missed' | 'no_show' | 'cancelled' | 'waitlist' | 'confirmed';

/**
 * A past reservation: present when it was checked in, otherwise its
 * status, and a confirmed seat nobody checked in reads as "missed".
 */
export function pastOutcome(reservation: MemberFileReservation): ReservationOutcome {
  if (reservation.status === 'cancelled') return 'cancelled';
  if (reservation.status === 'no_show') return 'no_show';
  if (reservation.checkedInAt !== null) return 'attended';
  return reservation.status === 'waitlist' ? 'waitlist' : 'missed';
}

/** A coming reservation: booked, waitlisted, or already checked in for a class about to start. */
export function upcomingOutcome(reservation: MemberFileReservation): ReservationOutcome {
  if (reservation.checkedInAt !== null) return 'attended';
  return reservation.status === 'waitlist' ? 'waitlist' : 'confirmed';
}
