/**
 * Codec for the {@link Reservation} domain model.
 *
 * Reservations are state-machine records: `status` drives which
 * timestamp fields are populated. `cancelledAt` is nullable and only
 * set when `status === 'cancelled'`; `checkedInAt` is only set after
 * a successful QR scan (Requirement 11.6). The codec preserves both
 * exactly as stored — no inference, no defaulting.
 *
 * Round-trip guarantee (Requirement 21.3):
 *   `ReservationCodec.fromJSON(ReservationCodec.toJSON(x))` is
 *   structurally equal to `x` for every valid `Reservation` value
 *   `x`.
 */

import { ReservationSchema, type Reservation } from '../schemas/domain.js';

import type { ReservationWire } from './types.js';

function toJSON(value: Reservation): ReservationWire {
    return {
        id: value.id,
        classId: value.classId,
        userId: value.userId,
        status: value.status,
        createdAt: value.createdAt,
        cancelledAt: value.cancelledAt,
        checkedInAt: value.checkedInAt,
    };
}

function fromJSON(raw: unknown): Reservation {
    return ReservationSchema.parse(raw);
}

export const ReservationCodec = {
    toJSON,
    fromJSON,
} as const;
