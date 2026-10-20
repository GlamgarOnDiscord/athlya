import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'ios' }));
const healthkit = vi.hoisted(() => ({
  isHealthDataAvailableAsync: vi.fn<() => Promise<boolean>>(),
  requestAuthorization: vi.fn<(request: unknown) => Promise<boolean>>(),
  queryWorkoutSamplesWithAnchor: vi.fn<(options: unknown) => Promise<unknown>>(),
}));

vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('@kingstinct/react-native-healthkit', () => healthkit);

const { createHealthKitStore } = await import('../../infrastructure/health/healthkit-store');

const START = new Date('2026-10-18T07:00:00.000Z');
const END = new Date('2026-10-18T07:45:00.000Z');

function proxy(overrides: Record<string, unknown> = {}) {
  return {
    uuid: 'HK-1',
    workoutActivityType: 37,
    startDate: START,
    endDate: END,
    duration: { unit: 's', quantity: 2700 },
    totalDistance: { unit: 'm', quantity: 8000 },
    totalEnergyBurned: { unit: 'kcal', quantity: 600 },
    getStatistic: vi.fn(() =>
      Promise.resolve({
        averageQuantity: { unit: 'count/min', quantity: 150 },
        maximumQuantity: { unit: 'count/min', quantity: 175 },
      }),
    ),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  platform.OS = 'ios';
  healthkit.isHealthDataAvailableAsync.mockResolvedValue(true);
  healthkit.requestAuthorization.mockResolvedValue(true);
});

describe('HealthKit store', () => {
  it('requests read access only, never write access', async () => {
    await createHealthKitStore().requestReadAuthorization();

    const [request] = healthkit.requestAuthorization.mock.calls[0] as [Record<string, unknown>];
    expect(request).not.toHaveProperty('toShare');
    expect(request['toRead']).toContain('HKWorkoutTypeIdentifier');
    expect(request['toRead']).toContain('HKQuantityTypeIdentifierHeartRate');
  });

  it('is unavailable off iOS without touching HealthKit', async () => {
    platform.OS = 'android';
    expect(await createHealthKitStore().isAvailable()).toBe(false);
    expect(healthkit.isHealthDataAvailableAsync).not.toHaveBeenCalled();

    platform.OS = 'ios';
    healthkit.isHealthDataAvailableAsync.mockResolvedValue(false);
    expect(await createHealthKitStore().isAvailable()).toBe(false);
  });

  it('reads a page from the anchor with the start date filter and heart rate statistics', async () => {
    const workout = proxy();
    healthkit.queryWorkoutSamplesWithAnchor.mockResolvedValue({
      workouts: [workout],
      deletedSamples: [],
      newAnchor: 'anchor-2',
    });
    const since = new Date('2026-09-19T00:00:00.000Z');

    const page = await createHealthKitStore().queryWorkouts({
      anchor: 'anchor-1',
      since,
      limit: 50,
    });

    expect(healthkit.queryWorkoutSamplesWithAnchor).toHaveBeenCalledWith({
      limit: 50,
      anchor: 'anchor-1',
      filter: { date: { startDate: since } },
    });
    expect(workout.getStatistic).toHaveBeenCalledWith(
      'HKQuantityTypeIdentifierHeartRate',
      'count/min',
    );
    expect(page).toEqual({
      anchor: 'anchor-2',
      workouts: [
        {
          uuid: 'HK-1',
          activityType: 37,
          startDate: START,
          endDate: END,
          duration: { unit: 's', quantity: 2700 },
          totalDistance: { unit: 'm', quantity: 8000 },
          totalEnergyBurned: { unit: 'kcal', quantity: 600 },
          averageHeartRateBpm: 150,
          maxHeartRateBpm: 175,
        },
      ],
    });
  });

  it('omits the anchor on the first read and imports a workout without heart rate access', async () => {
    const workout = proxy({
      totalDistance: undefined,
      totalEnergyBurned: undefined,
      getStatistic: vi.fn(() => Promise.reject(new Error('not authorized'))),
    });
    healthkit.queryWorkoutSamplesWithAnchor.mockResolvedValue({
      workouts: [workout],
      deletedSamples: [],
      newAnchor: 'anchor-1',
    });

    const page = await createHealthKitStore().queryWorkouts({
      anchor: null,
      since: START,
      limit: 10,
    });

    expect(healthkit.queryWorkoutSamplesWithAnchor.mock.calls[0]?.[0]).not.toHaveProperty('anchor');
    expect(page.workouts[0]).toEqual({
      uuid: 'HK-1',
      activityType: 37,
      startDate: START,
      endDate: END,
      duration: { unit: 's', quantity: 2700 },
    });
  });
});
