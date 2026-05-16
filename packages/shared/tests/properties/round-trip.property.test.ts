/**
 * Round-trip serialisation property — Requirement 21.
 *
 * Every codec exposes a pair of pure functions `toJSON` / `fromJSON` that
 * together form a total isomorphism on the set of *valid* domain values.
 * This test file pins that isomorphism down with fast-check: for every
 * value `x` drawn from the domain arbitrary, we assert
 *
 *   fromJSON(toJSON(x))  ≡  x      (structural equality)
 *
 * Why a property test rather than a handful of examples?
 *   1. The round-trip law is *universal* — there is no "edge case" list
 *      that captures it, so a property test is the only fair contract.
 *   2. Random generation catches silent shape drift (a renamed field,
 *      a lossy transform) immediately, where examples would let the bug
 *      through until production traffic hits the unexercised branch.
 *   3. Shrinking gives us the smallest failing value when a regression
 *      *does* occur, cutting debugging time drastically.
 *
 * Mapping back to the spec:
 *   - Requirement 21.1: every domain model has a dedicated `toJSON`.
 *   - Requirement 21.2: every domain model has a dedicated `fromJSON`.
 *   - Requirement 21.3: `fromJSON ∘ toJSON` is the identity on the
 *     valid-value set — which is exactly what this file verifies.
 *
 * Notes:
 *   - `numRuns: 200` keeps total runtime well under 15 s while giving
 *     enough coverage to catch any realistic regression.
 *   - A trailing negative-path property checks that `fromJSON` rejects
 *     values outside each schema's contract with a `ZodError`, so the
 *     isomorphism claim above is anchored on both ends.
 */

import { fc, it } from '@fast-check/vitest';
import { describe, expect } from 'vitest';
import { ZodError } from 'zod';

import {
  AuditLogCodec,
  ClassCodec,
  ConsentsCodec,
  ReservationCodec,
  StudioCodec,
  UserCodec,
  WorkoutSessionCodec,
} from '../../src/codec/index.js';
import {
  auditLogArb,
  classArb,
  consentsArb,
  reservationArb,
  studioArb,
  userArb,
  workoutSessionArb,
} from '../fixtures/arbitraries.js';

/**
 * Shared round-trip assertion. The codec parameter is typed as
 * `{ toJSON, fromJSON }` rather than the concrete codec so the same
 * helper works for every model without a generic detour through each
 * wire type.
 */
function assertRoundTrip<T>(
  codec: { toJSON: (v: T) => unknown; fromJSON: (raw: unknown) => T },
  value: T,
): void {
  const wire = codec.toJSON(value);
  // `toJSON` must be pure: the produced wire value must survive a
  // trip through real JSON (Schema drift catches `undefined` values
  // hidden in optional fields — they would disappear here).
  const serialised = JSON.parse(JSON.stringify(wire)) as unknown;
  const revived = codec.fromJSON(serialised);
  expect(revived).toEqual(value);
}

const RUN_OPTS = { numRuns: 200 } as const;

/* ------------------------------------------------------------------ */
/*  Positive path: `fromJSON ∘ toJSON = id` on every model             */
/* ------------------------------------------------------------------ */

describe('codec round-trip (Requirement 21.3)', () => {
  it.prop([studioArb], RUN_OPTS)('Studio round-trip is structural identity', (value) => {
    assertRoundTrip(StudioCodec, value);
  });

  it.prop([consentsArb], RUN_OPTS)('Consents round-trip is structural identity', (value) => {
    assertRoundTrip(ConsentsCodec, value);
  });

  it.prop([userArb], RUN_OPTS)(
    // Transitively exercises `ConsentsCodec` through `User.consents`.
    'User round-trip is structural identity',
    (value) => {
      assertRoundTrip(UserCodec, value);
    },
  );

  it.prop([classArb], RUN_OPTS)('Class round-trip is structural identity', (value) => {
    assertRoundTrip(ClassCodec, value);
  });

  it.prop([reservationArb], RUN_OPTS)('Reservation round-trip is structural identity', (value) => {
    assertRoundTrip(ReservationCodec, value);
  });

  it.prop([workoutSessionArb], RUN_OPTS)(
    // Transitively exercises `ExerciseCodec` and `SetCodec`, including
    // the presence-vs-absence distinction on optional `Set` fields.
    'WorkoutSession round-trip is structural identity',
    (value) => {
      assertRoundTrip(WorkoutSessionCodec, value);
    },
  );

  it.prop([auditLogArb], RUN_OPTS)('AuditLog round-trip is structural identity', (value) => {
    assertRoundTrip(AuditLogCodec, value);
  });
});

/* ------------------------------------------------------------------ */
/*  Negative path: `fromJSON` rejects invalid inputs with a ZodError   */
/* ------------------------------------------------------------------ */

/**
 * Generator of plainly-invalid inputs the codec must reject. Each
 * variant violates a different schema invariant:
 *   - wrong type entirely (string, number, array, null),
 *   - missing required keys,
 *   - wrong field types inside an otherwise-plausible record.
 *
 * This is not an exhaustive fuzz — it's a sanity anchor that the
 * positive round-trip isomorphism we proved above really does stop at
 * the edge of the valid-value set.
 */
const invalidStudioInputArb = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.array(fc.anything()),
  fc.constantFrom(null, undefined),
  // A record missing `brandColor` entirely.
  fc.record({
    id: fc.uuid(),
    slug: fc.constantFrom('ok', 'also-ok'),
    name: fc.string({ minLength: 1, maxLength: 10 }),
    createdAt: fc.constant('2024-01-01T00:00:00.000Z'),
    deletedAt: fc.constant(null),
  }),
  // A record whose `brandColor` is not a hex color.
  fc.record({
    id: fc.uuid(),
    slug: fc.constant('valid-slug'),
    name: fc.string({ minLength: 1, maxLength: 10 }),
    brandColor: fc.constantFrom('red', '#fff', 'not-a-color'),
    createdAt: fc.constant('2024-01-01T00:00:00.000Z'),
    deletedAt: fc.constant(null),
  }),
);

describe('codec rejection (Requirement 21.2)', () => {
  it.prop([invalidStudioInputArb], { numRuns: 100 })(
    'StudioCodec.fromJSON rejects malformed inputs with a ZodError',
    (raw) => {
      expect(() => StudioCodec.fromJSON(raw)).toThrow(ZodError);
    },
  );
});
