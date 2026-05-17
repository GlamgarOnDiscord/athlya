/**
 * Branded UUID types for Athlya domain identifiers.
 *
 * Plain `string` IDs are trivially interchangeable at the type level — it's
 * easy to pass a `classId` where a `userId` is expected. Branded types close
 * that hole by tagging the string with a unique phantom symbol that only the
 * smart constructors in this module can produce.
 *
 * Usage:
 * ```ts
 * import { UserId, isUserId } from '@athlya/shared/ids';
 *
 * const id = UserId('018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ab');
 * function load(user: UserId) { … }
 * if (isUserId(raw)) { load(raw); }
 * ```
 */

declare const __brand: unique symbol;

/**
 * Generic "opaque type" combinator. `Brand<string, 'UserId'>` is assignable
 * from a plain string only via the dedicated smart constructor — every other
 * attempt is rejected at compile time.
 */
export type Brand<T, B> = T & { readonly [__brand]: B };

export type UserId = Brand<string, 'UserId'>;
export type StudioId = Brand<string, 'StudioId'>;
export type ClassId = Brand<string, 'ClassId'>;
export type ReservationId = Brand<string, 'ReservationId'>;

/**
 * Accepts UUID versions 1–8 with RFC 4122 variant bits. This matches both the
 * legacy v4 IDs already present in seed data and the v7 IDs newly issued by
 * the database (Neon's `pgcrypto` / `uuid_generate_v7`). Case-insensitive.
 *
 * Exported so that downstream schema layers (`packages/shared/schemas/…`) can
 * validate the exact same shape instead of maintaining a parallel regex.
 */
export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Returns true when `value` is a string matching the UUID regex above.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

/**
 * Internal helper — builds both a smart constructor and a type guard for a
 * given branded ID. Keeps the 4 public IDs consistent and makes it cheap to
 * add more (e.g. `WorkoutSessionId`) later.
 */
function makeBrand<B extends Brand<string, string>>(
  label: string,
): {
  make: (value: string) => B;
  is: (value: unknown) => value is B;
} {
  return {
    make(value: string): B {
      if (!isUuid(value)) {
        throw new TypeError(`invalid UUID for ${label}: ${String(value)}`);
      }
      return value as B;
    },
    is(value: unknown): value is B {
      return isUuid(value);
    },
  };
}

const userIdBrand = makeBrand<UserId>('UserId');
const studioIdBrand = makeBrand<StudioId>('StudioId');
const classIdBrand = makeBrand<ClassId>('ClassId');
const reservationIdBrand = makeBrand<ReservationId>('ReservationId');

/**
 * Smart constructor — validates the UUID shape and brands the string.
 * Throws `TypeError('invalid UUID')` when the input is not a well-formed
 * UUID 1–8 string.
 */
export const UserId = (value: string): UserId => userIdBrand.make(value);
export const StudioId = (value: string): StudioId => studioIdBrand.make(value);
export const ClassId = (value: string): ClassId => classIdBrand.make(value);
export const ReservationId = (value: string): ReservationId => reservationIdBrand.make(value);

/**
 * Type guards — useful for narrowing API payloads validated by Zod before
 * they're handed to the domain layer.
 */
export const isUserId = userIdBrand.is;
export const isStudioId = studioIdBrand.is;
export const isClassId = classIdBrand.is;
export const isReservationId = reservationIdBrand.is;
