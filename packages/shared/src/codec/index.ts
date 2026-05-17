/**
 * Athlya codec layer — explicit conversion between domain values and
 * their JSON wire form.
 *
 * ## Date contract
 *
 * Athlya's codec layer uses ISO-8601 strings (with offset, e.g.
 * `2026-01-15T09:30:00.000Z`) as the wire format for every timestamp.
 * The domain layer also uses strings to match, so the Zod schemas stay
 * round-trip-clean under `.strict()` (see Requirement 21.3). If callers
 * need `Date` objects, they should `new Date(iso)` at the boundary,
 * outside the codec.
 *
 * Why strings instead of `Date`? Two reasons:
 *   1. Round-trip stability. `JSON.stringify(new Date(x))` returns an
 *      ISO string but `JSON.parse` does not rehydrate it — every client
 *      would need an ad-hoc post-processing step, and any field
 *      forgotten would silently become a plain string. Storing
 *      timestamps as strings end-to-end eliminates that class of bug.
 *   2. Determinism. Pure codec functions must be testable in isolation
 *      without stubbing the global clock. Using strings removes any
 *      temptation to call `new Date()` inside `toJSON`.
 *
 * ## BigInt contract
 *
 * `AuditLog.id` is a PostgreSQL `BIGSERIAL` that can exceed
 * `Number.MAX_SAFE_INTEGER`. The wire representation is always a
 * string; the DB-facing `bigint` ↔ `string` helpers live in
 * `./auditLog.ts` as {@link bigintToId} and {@link idToBigint}.
 *
 * ## Purity & errors
 *
 * Every `toJSON` is pure: no mutation of the input, no I/O, no
 * wall-clock reads. Every `fromJSON` delegates to the corresponding
 * Zod schema and therefore throws only {@link import('zod').ZodError}
 * on invalid input — never swallowed. The bigint helpers additionally
 * throw `SyntaxError('invalid AuditLog.id (not a bigint)')` on
 * malformed input.
 *
 * ## Public surface
 *
 * Each codec is exported individually (for fine-grained imports) and
 * aggregated into the {@link codec} object for convenience. Wire types
 * are re-exported from `./types.js` so callers typing HTTP request /
 * response bodies can use them without a second import.
 *
 * Related requirements: 21.1, 21.2, 21.3.
 */

import { AuditLogCodec, bigintToId, idToBigint } from './auditLog.js';
import { ClassCodec } from './class.js';
import { ReservationCodec } from './reservation.js';
import { StudioCodec } from './studio.js';
import { ConsentsCodec, UserCodec } from './user.js';
import { ExerciseCodec, SetCodec, WorkoutSessionCodec } from './workoutSession.js';

export * from './types.js';
export { StudioCodec } from './studio.js';
export { UserCodec, ConsentsCodec } from './user.js';
export { ClassCodec } from './class.js';
export { ReservationCodec } from './reservation.js';
export { WorkoutSessionCodec, ExerciseCodec, SetCodec } from './workoutSession.js';
export { AuditLogCodec, bigintToId, idToBigint } from './auditLog.js';

/**
 * Aggregate handle — `codec.studio.toJSON(x)`, `codec.auditLog.fromJSON(raw)`.
 *
 * Useful for generic helpers that pick the right codec by discriminator
 * (e.g. an outbox publisher that serialises whatever domain object the
 * caller hands it). Not required for day-to-day use — prefer the named
 * imports when a single codec is enough.
 */
export const codec = {
  studio: StudioCodec,
  user: UserCodec,
  consents: ConsentsCodec,
  class: ClassCodec,
  reservation: ReservationCodec,
  workoutSession: WorkoutSessionCodec,
  exercise: ExerciseCodec,
  set: SetCodec,
  auditLog: AuditLogCodec,
  bigintToId,
  idToBigint,
} as const;
