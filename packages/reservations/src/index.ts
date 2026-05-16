/**
 * Barrel export for `@athlya/reservations`.
 *
 * Subpath imports (`@athlya/reservations/state-machine`,
 * `@athlya/reservations/list`, `@athlya/reservations/counter`) are
 * preferred in downstream packages because they let bundlers skip
 * unused modules entirely. This barrel exists so tests, scripts and
 * documentation examples can pull everything from a single import
 * without paying a noticeable bundle cost.
 *
 * Later tasks in Epic 6 will add class creation and updates (6.2,
 * 6.3), the booking + cancellation flows (6.4, 6.5) and the QR
 * check-in handler (6.7) to this barrel.
 */

export * from './state-machine.js';
export * from './list.js';
export * from './counter.js';
export * from './checkin.js';
export * from './cancel.js';
export * from './book.js';
export type {
  CreateClassInput,
  CreateClassErrorCode,
  CreateClassRepoInput,
  RemainingCounterWriter,
  CreateClassDeps,
} from './create.js';
export { CreateClassError, createClass } from './create.js';
