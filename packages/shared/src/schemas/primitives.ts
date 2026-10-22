/**
 * Reusable Zod primitives shared by every domain and API schema.
 *
 * Centralising these here has three benefits:
 *   1. One canonical shape per concept (UUID, ISO-8601 datetime, slug, role…)
 *      so drift between files is impossible.
 *   2. The branded ID schemas produce the exact same brand tags as
 *      `@athlya/shared/ids`, letting API parse results flow straight into
 *      functions typed as `UserId`, `StudioId`, etc. without a redundant cast.
 *   3. Error messages stay uniform across the API surface.
 *
 * Related requirements:
 *   - Requirement 14.2 (API Gateway validates every body / query / param
 *     against shared Zod schemas).
 *   - Requirement 21.2 (deserialization into typed domain values).
 */

import { z } from 'zod';

import { UUID_REGEX } from '../ids.js';
import { ROLES } from '../roles.js';

import type { ClassId, ReservationId, StudioId, UserId } from '../ids.js';

/**
 * Raw UUID v1–8 string. Re-uses the same regex as {@link UUID_REGEX} from
 * `@athlya/shared/ids` so application-level and schema-level validation agree.
 */
export const UuidSchema = z
  .string()
  .regex(UUID_REGEX, 'must be a UUID v1–8 with RFC 4122 variant bits');

/**
 * ISO-8601 datetime with a mandatory UTC offset (`Z` or `±HH:MM`).
 * Matches what `Date#toISOString()` produces and what PostgreSQL's
 * `timestamptz` emits when we `SET TIMEZONE 'UTC'`. Used for every
 * `createdAt`, `startsAt`, `updatedAt`, `cancelledAt`, … field.
 */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/**
 * URL-safe studio slug. 3–50 chars, lowercase letters, digits and `-`.
 * Matches the validation rule attached to the `Studio.slug` domain model.
 */
export const SlugSchema = z
  .string()
  .regex(/^[a-z0-9-]{3,50}$/, 'must be 3–50 lowercase letters, digits or dashes');

/**
 * RBAC role. Strict enum so anything outside the closed set is rejected at
 * the API boundary rather than leaking into RLS session variables.
 */
export const RoleSchema = z.enum(ROLES);

/**
 * `#RRGGBB` hex color (6 hex digits, leading hash, optional case). Used by
 * the Studio brand customisation surface (`studios.brand_color`,
 * `PATCH /v1/studios/me`). The case-insensitive regex matches the runtime
 * helper {@link parseBrandColor} in `@athlya/shared/theming`; the API
 * layer normalises to lowercase via the helper before persisting.
 */
export const HexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'must be a #RRGGBB hex color');

/**
 * Reservation state. The full state machine lives in the reservations
 * service; this schema only ensures payloads carry one of the four allowed
 * labels. See Requirement 10.1 for the legal transition graph.
 */
export const ReservationStatusSchema = z.enum(['confirmed', 'waitlist', 'cancelled', 'no_show']);

/**
 * Branded ID schemas. Each one re-uses {@link UuidSchema} for validation
 * and then `.transform`s the raw string into the corresponding branded type
 * exported from `@athlya/shared/ids`.
 *
 * Why `.transform` and not Zod's `.brand()`?
 *   `.brand()` applies Zod's own `z.BRAND<...>` tag, which is structurally
 *   distinct from the module-private `__brand` symbol used by `ids.ts`.
 *   A Zod-branded `UserId` would therefore NOT be assignable to the domain
 *   `UserId`, forcing a second manual cast at every call site. The
 *   transform bridges the two systems cleanly: runtime shape stays a plain
 *   string (round-trip friendly) while the compile-time type equals the
 *   domain brand.
 */
export const UserIdSchema = UuidSchema.transform((v): UserId => v as UserId);
export const StudioIdSchema = UuidSchema.transform((v): StudioId => v as StudioId);
export const ClassIdSchema = UuidSchema.transform((v): ClassId => v as ClassId);
export const ReservationIdSchema = UuidSchema.transform((v): ReservationId => v as ReservationId);

/**
 * Compile-time sanity checks: if `z.infer<typeof UserIdSchema>` ever drifts
 * from the canonical `UserId` (e.g. someone swaps `.transform` for `.brand`),
 * these lines fail to compile and catch the drift immediately.
 */
type _UserIdMatches = z.infer<typeof UserIdSchema> extends UserId ? true : false;
type _StudioIdMatches = z.infer<typeof StudioIdSchema> extends StudioId ? true : false;
type _ClassIdMatches = z.infer<typeof ClassIdSchema> extends ClassId ? true : false;
type _ReservationIdMatches =
  z.infer<typeof ReservationIdSchema> extends ReservationId ? true : false;

const _userIdOk: _UserIdMatches = true;
const _studioIdOk: _StudioIdMatches = true;
const _classIdOk: _ClassIdMatches = true;
const _reservationIdOk: _ReservationIdMatches = true;

// Silence "declared but never read" in strict mode while keeping the checks alive.
void _userIdOk;
void _studioIdOk;
void _classIdOk;
void _reservationIdOk;
