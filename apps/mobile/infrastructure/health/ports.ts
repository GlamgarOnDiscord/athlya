/**
 * Apple Health (HealthKit) port, read-only. The import controller only
 * sees this interface, so it runs in Node tests against a fake;
 * `healthkit-store.ts` adapts `@kingstinct/react-native-healthkit` on iOS.
 */

/** A HealthKit quantity as reported, e.g. `{ unit: 'km', quantity: 5.2 }`. */
export interface HealthQuantity {
  readonly unit: string;
  readonly quantity: number;
}

export interface HealthWorkout {
  /** HealthKit workout UUID, stable across reads and devices. */
  readonly uuid: string;
  /** Raw `HKWorkoutActivityType` value. */
  readonly activityType: number;
  readonly startDate: Date;
  readonly endDate: Date;
  readonly duration: HealthQuantity;
  readonly totalEnergyBurned?: HealthQuantity;
  readonly totalDistance?: HealthQuantity;
  /** Heart rate statistics over the workout, in beats per minute. */
  readonly averageHeartRateBpm?: number;
  readonly maxHeartRateBpm?: number;
}

export interface HealthWorkoutQuery {
  /** Anchor of the previous page, or null for the first read. */
  readonly anchor: string | null;
  /** Workouts that start before this date are never returned. */
  readonly since: Date;
  readonly limit: number;
}

export interface HealthWorkoutPage {
  /** Workouts added since `anchor`, at most `limit`. */
  readonly workouts: readonly HealthWorkout[];
  /** Anchor to pass to the next query. */
  readonly anchor: string;
}

export interface HealthStore {
  /** False on devices without HealthKit (iPad without Health, Android). */
  readonly isAvailable: () => Promise<boolean>;
  /**
   * Shows the read permission sheet for the types the import needs.
   * HealthKit never reveals whether read access was granted: a denied
   * type simply returns no samples.
   */
  readonly requestReadAuthorization: () => Promise<void>;
  readonly queryWorkouts: (query: HealthWorkoutQuery) => Promise<HealthWorkoutPage>;
}
