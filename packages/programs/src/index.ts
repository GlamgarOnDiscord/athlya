/**
 * `@athlya/programs` — training programs domain (Epic 24).
 *
 * Hexagonal like `@athlya/reservations`: pure use cases over the
 * {@link ProgramRepo} port, wired to Drizzle + RLS by `@athlya/api`.
 */

export type {
  ActiveSchedule,
  NewProgram,
  NewSubscription,
  ProgramListFilter,
  ProgramPatch,
  ProgramRepo,
  ProgramUpdateOutcome,
  ProgramViewer,
  SubscribeOutcome,
} from './ports.js';
export {
  addDays,
  daysBetween,
  isLocalDate,
  resolveScheduleDay,
  resolveTodayItem,
  utcDate,
  type ScheduleDay,
} from './schedule.js';
export {
  SUBSCRIPTION_START_FUTURE_DAYS,
  SUBSCRIPTION_START_PAST_DAYS,
  archiveProgram,
  createProgram,
  getProgram,
  getTodayWorkouts,
  listMySubscriptions,
  listPrograms,
  subscribeToProgram,
  unsubscribeFromProgram,
  updateProgram,
  type ArchiveProgramOutcome,
  type CreateProgramOutcome,
  type ProgramsServiceDeps,
  type SubscribeProgramOutcome,
  type UnsubscribeOutcome,
  type UpdateProgramOutcome,
} from './service.js';
