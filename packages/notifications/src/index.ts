/**
 * Barrel export for `@athlya/notifications`.
 *
 * Subpath imports (`@athlya/notifications/consumer`,
 * `@athlya/notifications/scheduler`) are preferred in downstream
 * packages because they let bundlers skip unused modules entirely.
 * This barrel exists so tests, scripts and documentation examples
 * can pull everything from a single import without paying a
 * noticeable bundle cost.
 *
 * Task 9.7 will add dedicated test-only exports and extend this
 * barrel accordingly.
 *
 * Both `consumer.ts` and `scheduler.ts` expose a local `Clock` type
 * alias (`() => number`, Unix-ms). They are structurally identical,
 * but a blanket `export *` would make TypeScript flag the duplicate
 * as TS2308. We therefore re-export everything from `consumer` and
 * everything-except-`Clock` from `scheduler`; callers who want the
 * scheduler's clock alias can either import via the
 * `./scheduler` subpath or rely on the shared shape.
 */

export * from './consumer.js';
export {
  REMINDER_LEAD_MS,
  onReservationCreated,
  scheduleReservationReminder,
  type OnReservationCreatedDeps,
  type ReminderScheduleCommand,
  type ReminderScheduler,
  type ReservationLookupRepo,
  type ReservationReminderInput,
  type ScheduleReservationReminderArgs,
  type ScheduleResult,
} from './scheduler.js';
