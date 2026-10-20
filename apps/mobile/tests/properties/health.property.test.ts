/**
 * Apple Health mapping properties (task 18.1):
 *   - any workout HealthKit can report maps to null or to a request the
 *     API accepts (`LogSessionRequestSchema`), never throws;
 *   - a mapped request always names its workout as the source;
 *   - its `cardio` summary, when present, passes `CardioMetricsSchema`,
 *     carries the set duration and at least one reported metric, and
 *     never names a machine;
 *   - the import key is a UUID v4 and a function of the workout id only.
 */
import { createTranslator } from '@athlya/shared/i18n';
import { LogSessionRequestSchema } from '@athlya/shared/schemas/api';
import { CardioMetricsSchema } from '@athlya/shared/schemas/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  buildHealthSessionRequest,
  importIdempotencyKey,
} from '../../features/health/workout-mapping';
import { isUuidV4 } from '../../infrastructure/ids';
import { sha256 } from '../health-helpers';

import type { HealthQuantity, HealthWorkout } from '../../infrastructure/health/ports';

const en = createTranslator('en');
const fr = createTranslator('fr');

const quantity = (units: readonly string[]): fc.Arbitrary<HealthQuantity> =>
  fc.record({
    unit: fc.oneof(fc.constantFrom(...units), fc.string({ maxLength: 6 })),
    quantity: fc.oneof(fc.double(), fc.double({ min: 0, max: 1e6, noNaN: true })),
  });

const date = fc.date({ min: new Date('1990-01-01'), max: new Date('2100-01-01') });

const healthWorkout: fc.Arbitrary<HealthWorkout> = fc.record(
  {
    uuid: fc.oneof(
      fc.uuid().map((u) => u.toUpperCase()),
      fc.string({ maxLength: 140 }),
    ),
    activityType: fc.oneof(fc.integer({ min: 0, max: 100 }), fc.constantFrom(2998, 2999, 3000)),
    startDate: fc.oneof(date, fc.constant(new Date(Number.NaN))),
    endDate: date,
    duration: quantity(['s', 'min', 'hr', 'ms']),
    totalEnergyBurned: quantity(['kcal', 'Cal', 'kJ', 'J']),
    totalDistance: quantity(['m', 'km', 'mi', 'ft']),
    averageHeartRateBpm: fc.double(),
    maxHeartRateBpm: fc.double(),
  },
  { requiredKeys: ['uuid', 'activityType', 'startDate', 'endDate', 'duration'] },
);

describe('Apple Health mapping properties', () => {
  it('maps every workout to null or to a valid request naming its workout', () => {
    fc.assert(
      fc.property(healthWorkout, fc.boolean(), (workout, french) => {
        const request = french
          ? buildHealthSessionRequest(workout, fr, 'fr')
          : buildHealthSessionRequest(workout, en, 'en');
        if (request === null) return;
        expect(LogSessionRequestSchema.safeParse(request).success).toBe(true);
        expect(request.source).toEqual({
          provider: 'appleHealth',
          externalId: workout.uuid.trim(),
        });
        expect(request.exercises).toHaveLength(1);
        expect(request.durationMin).toBeGreaterThanOrEqual(1);
        if (request.cardio !== undefined) {
          expect(CardioMetricsSchema.safeParse(request.cardio).success).toBe(true);
          expect(request.cardio.durationSec).toBe(request.exercises[0]?.sets[0]?.durationSec);
          expect(request.cardio.machine).toBeUndefined();
          expect(Object.keys(request.cardio).length).toBeGreaterThan(1);
        }
      }),
    );
  });

  it('derives a stable UUID v4 key from the workout id alone', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 128 }), async (externalId) => {
        const key = await importIdempotencyKey(sha256, 'appleHealth', externalId);
        expect(isUuidV4(key)).toBe(true);
        expect(await importIdempotencyKey(sha256, 'appleHealth', externalId)).toBe(key);
      }),
    );
  });

  it('gives distinct workouts distinct keys', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), fc.uuid(), async (a, b) => {
        fc.pre(a !== b);
        expect(await importIdempotencyKey(sha256, 'appleHealth', a)).not.toBe(
          await importIdempotencyKey(sha256, 'appleHealth', b),
        );
      }),
    );
  });
});
