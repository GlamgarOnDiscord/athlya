/**
 * Codec for the {@link Studio} domain model.
 *
 * The codec layer is the single narrow waist between runtime JSON
 * received over HTTP (or pulled out of a DB driver) and the typed domain
 * values the rest of the platform manipulates. Every codec exposes two
 * pure functions:
 *
 *   - `toJSON(value)`: reshapes a domain value into its wire form.
 *     Pure, deterministic, no I/O, no wall-clock reads, no exceptions.
 *     Safe to call from any context, including hot loops.
 *   - `fromJSON(raw)`: validates an unknown value through the
 *     corresponding Zod schema and returns the typed domain value.
 *     The only exception it propagates is {@link import('zod').ZodError},
 *     letting the API gateway translate validation failures into
 *     RFC 7807 Problem Details.
 *
 * Round-trip guarantee (Requirement 21.3): for every valid `Studio`
 * value `x`, `StudioCodec.fromJSON(StudioCodec.toJSON(x))` is
 * structurally equal to `x`.
 */

import { StudioSchema, type Studio } from '../schemas/domain.js';

import type { StudioWire } from './types.js';

/**
 * Serialise a {@link Studio} to its JSON wire form.
 *
 * All timestamp fields on `Studio` are already ISO-8601 strings at the
 * type level, so this function is effectively an identity projection.
 * The shape is kept explicit (rather than a bare spread) so that any
 * future drift between `Studio` and `StudioWire` fails the compile step
 * here instead of silently losing a field at runtime.
 */
function toJSON(value: Studio): StudioWire {
  return {
    id: value.id,
    slug: value.slug,
    name: value.name,
    brandColor: value.brandColor,
    createdAt: value.createdAt,
    deletedAt: value.deletedAt,
  };
}

/**
 * Parse an unknown value as a {@link Studio}. Delegates to Zod; throws
 * `ZodError` on invalid input.
 */
function fromJSON(raw: unknown): Studio {
  return StudioSchema.parse(raw);
}

export const StudioCodec = {
  toJSON,
  fromJSON,
} as const;
