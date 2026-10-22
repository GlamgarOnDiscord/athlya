/**
 * Ports of the training-programs domain (Epic 24).
 *
 * The service never touches a database: a {@link ProgramRepo} is bound
 * to the caller's tenant claims by the adapter (the API wires it to
 * Drizzle under `withTenant`, so RLS scopes every query to the
 * caller's studio and role). The views are the wire shapes from
 * `@athlya/shared/schemas/api`, so the adapter maps rows once.
 */

import type { Role } from '@athlya/shared/roles';
import type {
  ProgramDetail,
  ProgramStatus,
  ProgramSubscription,
  ProgramSummary,
  ProgramWeekInput,
} from '@athlya/shared/schemas/api';

/** Authenticated caller, from the verified JWT claims. */
export interface ProgramViewer {
  readonly userId: string;
  readonly studioId: string;
  readonly role: Role;
}

export interface ProgramListFilter {
  readonly status?: ProgramStatus;
}

/** Row written by {@link ProgramRepo.create}. */
export interface NewProgram {
  readonly studioId: string;
  readonly createdBy: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: 'draft' | 'published';
  readonly weeks: ReadonlyArray<ProgramWeekInput>;
}

/** Fields changed by {@link ProgramRepo.update}; `weeks` replaces the schedule. */
export interface ProgramPatch {
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: 'draft' | 'published';
  readonly weeks?: ReadonlyArray<ProgramWeekInput>;
}

export type ProgramUpdateOutcome =
  | { readonly kind: 'updated'; readonly program: ProgramDetail }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'archived' }
  | { readonly kind: 'not_found' };

export interface NewSubscription {
  readonly programId: string;
  readonly studioId: string;
  readonly userId: string;
  readonly startsOn: string;
}

export type SubscribeOutcome =
  | { readonly kind: 'subscribed'; readonly subscription: ProgramSubscription }
  | { readonly kind: 'already_subscribed'; readonly subscription: ProgramSubscription }
  | { readonly kind: 'not_subscribable' };

/** An active subscription with the full schedule of its program. */
export interface ActiveSchedule {
  readonly subscription: ProgramSubscription;
  readonly program: ProgramDetail;
}

export interface ProgramRepo {
  /** Programs visible to the caller (RLS), most recently updated first. */
  list(filter: ProgramListFilter): Promise<ReadonlyArray<ProgramSummary>>;
  /** A visible program with its weeks and workouts, or `null`. */
  get(programId: string): Promise<ProgramDetail | null>;
  create(input: NewProgram): Promise<ProgramDetail>;
  /**
   * Apply `patch` when the stored version equals `expectedVersion` and
   * the program is not archived; bumps the version.
   */
  update(
    programId: string,
    expectedVersion: number,
    patch: ProgramPatch,
  ): Promise<ProgramUpdateOutcome>;
  /** Archive the program (idempotent); `null` when it is not visible. */
  archive(programId: string): Promise<ProgramDetail | null>;
  subscribe(input: NewSubscription): Promise<SubscribeOutcome>;
  /** Stamp `cancelled_at` on the caller's active subscription; `false` when none. */
  cancelSubscription(programId: string, userId: string): Promise<boolean>;
  /** The caller's active subscriptions, oldest first. */
  listSubscriptions(userId: string): Promise<ReadonlyArray<ProgramSubscription>>;
  /** The caller's active subscriptions with their programs' schedules. */
  listActiveSchedules(userId: string): Promise<ReadonlyArray<ActiveSchedule>>;
}
