/**
 * `@kingstinct/react-native-healthkit` adapter for the {@link HealthStore}
 * port. Read-only: the permission request never asks to share (write)
 * any type. Off iOS the library exports stubs and this store reports
 * HealthKit as unavailable without calling them.
 */
import {
  isHealthDataAvailableAsync,
  queryWorkoutSamplesWithAnchor,
  requestAuthorization,
} from '@kingstinct/react-native-healthkit';
import { Platform } from 'react-native';

import type { HealthStore, HealthWorkout } from './ports';
import type { WorkoutProxyTyped } from '@kingstinct/react-native-healthkit';

/** Workouts, plus the samples their totals and heart rate statistics read. */
const READ_TYPES = [
  'HKWorkoutTypeIdentifier',
  'HKQuantityTypeIdentifierHeartRate',
  'HKQuantityTypeIdentifierActiveEnergyBurned',
  'HKQuantityTypeIdentifierDistanceWalkingRunning',
  'HKQuantityTypeIdentifierDistanceCycling',
  'HKQuantityTypeIdentifierDistanceSwimming',
] as const;

async function heartRate(
  workout: WorkoutProxyTyped,
): Promise<Pick<HealthWorkout, 'averageHeartRateBpm' | 'maxHeartRateBpm'>> {
  try {
    const stats = await workout.getStatistic('HKQuantityTypeIdentifierHeartRate', 'count/min');
    return {
      ...(stats?.averageQuantity === undefined
        ? {}
        : { averageHeartRateBpm: stats.averageQuantity.quantity }),
      ...(stats?.maximumQuantity === undefined
        ? {}
        : { maxHeartRateBpm: stats.maximumQuantity.quantity }),
    };
  } catch {
    // No heart rate access or no samples: the workout imports without it.
    return {};
  }
}

async function toHealthWorkout(workout: WorkoutProxyTyped): Promise<HealthWorkout> {
  return {
    uuid: workout.uuid,
    activityType: workout.workoutActivityType,
    startDate: workout.startDate,
    endDate: workout.endDate,
    duration: workout.duration,
    ...(workout.totalEnergyBurned === undefined
      ? {}
      : { totalEnergyBurned: workout.totalEnergyBurned }),
    ...(workout.totalDistance === undefined ? {} : { totalDistance: workout.totalDistance }),
    ...(await heartRate(workout)),
  };
}

export function createHealthKitStore(): HealthStore {
  return {
    isAvailable: async () => Platform.OS === 'ios' && (await isHealthDataAvailableAsync()),
    requestReadAuthorization: async () => {
      await requestAuthorization({ toRead: READ_TYPES });
    },
    queryWorkouts: async ({ anchor, since, limit }) => {
      const result = await queryWorkoutSamplesWithAnchor({
        limit,
        ...(anchor === null ? {} : { anchor }),
        filter: { date: { startDate: since } },
      });
      const workouts: HealthWorkout[] = [];
      for (const workout of result.workouts) workouts.push(await toHealthWorkout(workout));
      return { workouts, anchor: result.newAnchor };
    },
  };
}
