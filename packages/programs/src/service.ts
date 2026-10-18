/**
 * Training-programs use cases (Epic 24, tasks 24.2).
 *
 *   - Admins create, update (optimistic lock) and archive programs.
 *   - Any authenticated user of the studio subscribes to a published
 *     program and unsubscribes from it.
 *   - `getTodayWorkouts` resolves, for each active subscription, the
 *     workout prescribed on a given date — the mobile home contract.
 *
 * Request bodies arrive already validated by the shared Zod schemas at
 * the gateway. The service adds the rules that depend on the caller or
 * on the clock, and returns discriminated outcomes instead of throwing
 * so the router maps each one to its HTTP status. Authorization is
 * checked here as well as by the router and by RLS (defence in depth).
 */

import { daysBetween, resolveTodayItem, utcDate } from './schedule.js';

import type {
  ActiveSchedule,
  ProgramPatch,
  ProgramRepo,
  ProgramUpdateOutcome,
  ProgramViewer,
  SubscribeOutcome,
} from './ports.js';
import type {
  CreateProgramRequest,
  ListProgramsQuery,
  ProgramDetail,
  ProgramSubscription,
  ProgramSummary,
  SubscribeProgramRequest,
  TodayWorkoutResponse,
  UpdateProgramRequest,
} from '@athlya/shared/schemas/api';

export interface ProgramsServiceDeps {
  readonly repo: ProgramRepo;
  /** Injected clock; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** A subscription may start up to 4 weeks ago (catching up) or 13 weeks ahead. */
export const SUBSCRIPTION_START_PAST_DAYS = 28;
export const SUBSCRIPTION_START_FUTURE_DAYS = 91;

type Forbidden = { readonly kind: 'forbidden' };

function today(deps: ProgramsServiceDeps): string {
  return utcDate(new Date((deps.now ?? Date.now)()));
}

function isAdmin(viewer: ProgramViewer): boolean {
  return viewer.role === 'admin';
}

function isStaff(viewer: ProgramViewer): boolean {
  return viewer.role === 'admin' || viewer.role === 'coach';
}

/* ------------------------------------------------------------------ */
/*  Catalogue                                                          */
/* ------------------------------------------------------------------ */

/**
 * Staff see every program of the studio, optionally filtered by status.
 * Members browse the catalogue: published programs only (the programs
 * they follow, archived ones included, come from `listMySubscriptions`).
 */
export async function listPrograms(
  viewer: ProgramViewer,
  query: ListProgramsQuery,
  deps: ProgramsServiceDeps,
): Promise<ReadonlyArray<ProgramSummary>> {
  if (isStaff(viewer)) {
    return deps.repo.list(query.status === undefined ? {} : { status: query.status });
  }
  if (query.status !== undefined && query.status !== 'published') return [];
  return deps.repo.list({ status: 'published' });
}

/** A program the caller may see (RLS decides), or `null`. */
export async function getProgram(
  programId: string,
  deps: ProgramsServiceDeps,
): Promise<ProgramDetail | null> {
  return deps.repo.get(programId);
}

/* ------------------------------------------------------------------ */
/*  Authoring (admin)                                                  */
/* ------------------------------------------------------------------ */

export type CreateProgramOutcome =
  { readonly kind: 'created'; readonly program: ProgramDetail } | Forbidden;

export async function createProgram(
  viewer: ProgramViewer,
  input: CreateProgramRequest,
  deps: ProgramsServiceDeps,
): Promise<CreateProgramOutcome> {
  if (!isAdmin(viewer)) return { kind: 'forbidden' };
  const program = await deps.repo.create({
    studioId: viewer.studioId,
    createdBy: viewer.userId,
    title: input.title,
    description: input.description ?? null,
    status: input.status ?? 'draft',
    weeks: input.weeks,
  });
  return { kind: 'created', program };
}

export type UpdateProgramOutcome = ProgramUpdateOutcome | Forbidden;

export async function updateProgram(
  viewer: ProgramViewer,
  programId: string,
  input: UpdateProgramRequest,
  deps: ProgramsServiceDeps,
): Promise<UpdateProgramOutcome> {
  if (!isAdmin(viewer)) return { kind: 'forbidden' };
  const patch: ProgramPatch = {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.weeks !== undefined ? { weeks: input.weeks } : {}),
  };
  return deps.repo.update(programId, input.version, patch);
}

export type ArchiveProgramOutcome =
  | { readonly kind: 'archived'; readonly program: ProgramDetail }
  | { readonly kind: 'not_found' }
  | Forbidden;

/** Archiving is terminal and idempotent: archiving twice returns the program. */
export async function archiveProgram(
  viewer: ProgramViewer,
  programId: string,
  deps: ProgramsServiceDeps,
): Promise<ArchiveProgramOutcome> {
  if (!isAdmin(viewer)) return { kind: 'forbidden' };
  const program = await deps.repo.archive(programId);
  return program === null ? { kind: 'not_found' } : { kind: 'archived', program };
}

/* ------------------------------------------------------------------ */
/*  Subscriptions                                                      */
/* ------------------------------------------------------------------ */

export type SubscribeProgramOutcome =
  SubscribeOutcome | { readonly kind: 'not_found' } | { readonly kind: 'invalid_start' };

export async function subscribeToProgram(
  viewer: ProgramViewer,
  programId: string,
  input: SubscribeProgramRequest,
  deps: ProgramsServiceDeps,
): Promise<SubscribeProgramOutcome> {
  const current = today(deps);
  const startsOn = input.startsOn ?? current;
  const offset = daysBetween(current, startsOn);
  if (offset < -SUBSCRIPTION_START_PAST_DAYS || offset > SUBSCRIPTION_START_FUTURE_DAYS) {
    return { kind: 'invalid_start' };
  }

  const program = await deps.repo.get(programId);
  if (program === null) return { kind: 'not_found' };
  if (program.status !== 'published') return { kind: 'not_subscribable' };

  return deps.repo.subscribe({
    programId,
    studioId: viewer.studioId,
    userId: viewer.userId,
    startsOn,
  });
}

export type UnsubscribeOutcome = { readonly kind: 'unsubscribed' } | { readonly kind: 'not_found' };

export async function unsubscribeFromProgram(
  viewer: ProgramViewer,
  programId: string,
  deps: ProgramsServiceDeps,
): Promise<UnsubscribeOutcome> {
  const cancelled = await deps.repo.cancelSubscription(programId, viewer.userId);
  return cancelled ? { kind: 'unsubscribed' } : { kind: 'not_found' };
}

export async function listMySubscriptions(
  viewer: ProgramViewer,
  deps: ProgramsServiceDeps,
): Promise<ReadonlyArray<ProgramSubscription>> {
  return deps.repo.listSubscriptions(viewer.userId);
}

/* ------------------------------------------------------------------ */
/*  Daily prescribed workout                                           */
/* ------------------------------------------------------------------ */

/**
 * The workout each active subscription prescribes on `date` (the
 * member's local date, defaulting to the server's UTC date). Items are
 * ordered by subscription start; a date more than a year away from the
 * server's is refused so a skewed client cannot scan arbitrary dates.
 */
export async function getTodayWorkouts(
  viewer: ProgramViewer,
  date: string | undefined,
  deps: ProgramsServiceDeps,
): Promise<TodayWorkoutResponse | { readonly kind: 'invalid_date' }> {
  const current = today(deps);
  const target = date ?? current;
  if (Math.abs(daysBetween(current, target)) > 366) return { kind: 'invalid_date' };

  const schedules: ReadonlyArray<ActiveSchedule> = await deps.repo.listActiveSchedules(
    viewer.userId,
  );
  return {
    date: target,
    items: schedules.map((schedule) => resolveTodayItem(schedule, target)),
  };
}
