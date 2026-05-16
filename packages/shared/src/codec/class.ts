/**
 * Codec for the {@link Class} domain model (a planned session in a
 * studio calendar).
 *
 * `Class.version` is the optimistic-lock counter (Requirement 6.6).
 * It travels as a plain JSON number on the wire and is preserved
 * by both `toJSON` and `fromJSON` — the codec has no policy around
 * versioning, only around shape.
 *
 * Round-trip guarantee (Requirement 21.3):
 *   `ClassCodec.fromJSON(ClassCodec.toJSON(x))` is structurally
 *   equal to `x` for every valid `Class` value `x`.
 */

import { ClassSchema, type Class } from '../schemas/domain.js';

import type { ClassWire } from './types.js';

function toJSON(value: Class): ClassWire {
  return {
    id: value.id,
    studioId: value.studioId,
    coachId: value.coachId,
    title: value.title,
    startsAt: value.startsAt,
    durationMin: value.durationMin,
    capacity: value.capacity,
    version: value.version,
    createdAt: value.createdAt,
  };
}

function fromJSON(raw: unknown): Class {
  return ClassSchema.parse(raw);
}

export const ClassCodec = {
  toJSON,
  fromJSON,
} as const;
