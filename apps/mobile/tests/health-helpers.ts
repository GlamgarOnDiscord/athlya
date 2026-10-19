import { createHash } from 'node:crypto';

import { vi } from 'vitest';

import type {
  HealthStore,
  HealthWorkout,
  HealthWorkoutPage,
  HealthWorkoutQuery,
} from '../infrastructure/health/ports';

export const sha256 = (input: string): Promise<string> =>
  Promise.resolve(createHash('sha256').update(input, 'utf8').digest('hex'));

export function workout(overrides: Partial<HealthWorkout> = {}): HealthWorkout {
  return {
    uuid: '5B2D7C1E-3F4A-4B6C-8D9E-0F1A2B3C4D5E',
    activityType: 37,
    startDate: new Date('2026-10-18T07:00:00.000Z'),
    endDate: new Date('2026-10-18T07:45:00.000Z'),
    duration: { unit: 's', quantity: 2700 },
    totalDistance: { unit: 'm', quantity: 8240 },
    totalEnergyBurned: { unit: 'kcal', quantity: 612.4 },
    averageHeartRateBpm: 151.6,
    maxHeartRateBpm: 178,
    ...overrides,
  };
}

/**
 * In-memory HealthKit: `workouts` is the store in insertion order, the
 * anchor is the number of workouts already returned.
 */
export class FakeHealthStore implements HealthStore {
  public available = true;
  public workouts: HealthWorkout[] = [];
  public queryError: Error | null = null;

  public readonly isAvailable = vi.fn(() => Promise.resolve(this.available));
  public readonly requestReadAuthorization = vi.fn(() => Promise.resolve());
  public readonly queryWorkouts = vi.fn((query: HealthWorkoutQuery): Promise<HealthWorkoutPage> => {
    if (this.queryError !== null) return Promise.reject(this.queryError);
    const start = query.anchor === null ? 0 : Number(query.anchor);
    const page = this.workouts
      .slice(start, start + query.limit)
      .filter((w) => w.startDate.getTime() >= query.since.getTime());
    const next = Math.min(start + query.limit, this.workouts.length);
    return Promise.resolve({ workouts: page, anchor: String(next) });
  });
}
