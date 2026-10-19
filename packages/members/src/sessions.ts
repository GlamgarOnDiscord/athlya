/**
 * Members service — workout session use cases.
 *
 * Implements task 5.5 of the Athlya implementation plan. The two use
 * cases exposed by this module are:
 *
 *   - {@link logSession}   — persist a new workout session (Req 12.1)
 *     with strict bounds on `exercises` (≤ 50, Req 12.2) and `sets`
 *     per exercise (≤ 30, Req 12.3).
 *   - {@link listSessions} — paginated history window ordered by
 *     `started_at DESC` (Req 12.4), capped at the same 90-day window
 *     the class browsing endpoint uses.
 *
 * Validation is delegated entirely to the shared Zod schemas from
 * `@athlya/shared/schemas/api`: `LogSessionRequestSchema` already
 * enforces the 50-exercise + 30-set-per-exercise upper bounds via
 * `ExerciseSchema` / `SetSchema`, and `ListSessionsQuerySchema`
 * carries the `to > from` + 90-day-span refinements. Any schema
 * failure surfaces as a {@link MembersError} with
 * `code = 'validation_failed'` carrying the normalised issue list,
 * so the API gateway can render an RFC 7807 Problem Details body
 * exactly as it does for the profile use cases in `./service.ts`.
 *
 * As with the other members use cases this module is framework-free:
 * it depends only on a pluggable {@link WorkoutSessionRepo}. The
 * concrete Drizzle-backed repo is wired in the API gateway and is
 * responsible for running every call under `withTenant(claims, fn)`
 * so that RLS (Requirement 13) is applied. In particular the
 * `ORDER BY started_at DESC` clause required by Req 12.4 lives in
 * the repo's `listByUser` implementation — this service only guards
 * the input and hands the work off.
 */

import { LogSessionRequestSchema, ListSessionsQuerySchema } from '@athlya/shared/schemas/api';

import { MembersError, type MembersValidationIssue } from './service.js';

import type { SessionSource } from '@athlya/shared/schemas/api';
import type { CardioMetrics, Exercise, WorkoutSession } from '@athlya/shared/schemas/domain';

/* ------------------------------------------------------------------ */
/*  Repository port                                                    */
/* ------------------------------------------------------------------ */

/**
 * Input shape passed to {@link WorkoutSessionRepo.create}. Mirrors the
 * columns of the `workout_sessions` table, minus the server-assigned
 * `id` and `createdAt` (those are filled in by the repo / database).
 *
 * `studioId` is optional to cover solo workouts done outside a partner
 * studio (Requirement 12.1). `durationMin` and `notes` are optional
 * since the service never fills them in with defaults — it passes them
 * through verbatim from the parsed request body.
 */
export interface CreateWorkoutSessionInput {
  userId: string;
  studioId?: string | undefined;
  startedAt: string;
  durationMin?: number | undefined;
  exercises: ReadonlyArray<Exercise>;
  notes?: string | undefined;
  /** Structured cardio summary of a machine session (issue #667). */
  cardio?: CardioMetrics | undefined;
  /**
   * `Idempotency-Key` of the request. A repo that receives the same key
   * twice for the same user returns the first session instead of
   * inserting a second one.
   */
  idempotencyKey?: string | undefined;
  /** App and workout id of an imported session (task 18.1). */
  source?: SessionSource | undefined;
}

/**
 * Options accepted by {@link WorkoutSessionRepo.listByUser}. The
 * service converts the ISO-8601 strings from the query schema into
 * `Date` instances before calling the repo so the SQL layer can bind
 * them as timestamptz without re-parsing.
 */
export interface ListWorkoutSessionsOptions {
  /** Inclusive lower bound of the window. */
  from: Date;
  /** Exclusive upper bound of the window. */
  to: Date;
  /** Maximum number of rows to return. The service always passes 100. */
  limit: number;
}

/**
 * Minimal contract the workout session use cases need from the
 * persistence layer.
 *
 * Declared here (rather than in `@athlya/db`) so the service owns its
 * own port and so unit tests can provide a trivial `vi.fn()` double
 * without pulling Drizzle or Postgres into the test runtime. The
 * concrete implementation lives in the API gateway wiring; it is
 * responsible for:
 *
 *   - running under the tenant-aware `withTenant(claims, fn)` helper
 *     so RLS is applied (Requirement 13),
 *   - ordering `listByUser` results by `started_at DESC`
 *     (Requirement 12.4).
 */
export interface WorkoutSessionRepo {
  /**
   * Persist a new workout session and return the stored row.
   *
   * The caller has already validated `input` through
   * {@link LogSessionRequestSchema}; the repo inserts the supplied
   * fields and returns the resulting {@link WorkoutSession}.
   *
   * Dedupe contract: when `input.idempotencyKey` is set and a session
   * with the same `(userId, idempotencyKey)` already exists, the repo
   * MUST NOT insert a second row and MUST return the existing session,
   * also when two such calls race. Without a key every call inserts.
   * The same holds for `input.source`: a second session with the same
   * `(userId, source.provider, source.externalId)` is not inserted and
   * the existing one is returned.
   */
  create(input: CreateWorkoutSessionInput): Promise<WorkoutSession>;

  /**
   * Return the member's workout sessions whose `started_at` falls
   * within `[from, to)`, ordered `started_at DESC`, capped at
   * `limit` rows. The repo is responsible for the ordering clause —
   * the service contract requires descending order (Req 12.4) but
   * the service itself does no post-filtering.
   */
  listByUser(userId: string, opts: ListWorkoutSessionsOptions): Promise<WorkoutSession[]>;
}

/**
 * Dependencies injected into every workout session use case. `now` is
 * exposed for future timestamp-sensitive logic and for tests that
 * want to freeze the clock; the two task 5.5 use cases don't read it
 * today but it is part of the shared shape to keep the service
 * signature stable.
 */
export interface SessionsServiceDeps {
  repo: WorkoutSessionRepo;
  /** Defaults to `Date.now`. Supplied explicitly in tests. */
  now?: () => number;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/**
 * Hard ceiling on the number of rows returned by {@link listSessions}.
 * Chosen to match the class-listing endpoint's pagination policy: the
 * Zod schema already caps the window to 90 days, so 100 rows is a
 * generous-but-bounded page size that protects both the gateway and
 * the mobile client from paging pathologies.
 */
const LIST_SESSIONS_HARD_LIMIT = 100;

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Convert a Zod issue list into the normalised {@link MembersValidationIssue}
 * shape used by {@link MembersError}. Extracted so both use cases
 * produce identical error shapes regardless of which schema tripped.
 */
function toValidationIssues(
  issues: ReadonlyArray<{
    path: ReadonlyArray<PropertyKey>;
    code: string;
    message: string;
  }>,
): MembersValidationIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    code: issue.code,
    message: issue.message,
  }));
}

/**
 * Build a readable `message` string from a list of normalised issues.
 * Matches the format used by `./service.ts` so gateway logs stay
 * consistent across use cases.
 */
function formatIssueSummary(prefix: string, issues: ReadonlyArray<MembersValidationIssue>): string {
  return `${prefix}: ${issues.map((i) => `${i.path || '<root>'} ${i.message}`).join('; ')}`;
}

/* ------------------------------------------------------------------ */
/*  Use case 1 — log a workout session                                 */
/* ------------------------------------------------------------------ */

/**
 * Persist a new workout session for `userId`.
 *
 * The payload is validated with {@link LogSessionRequestSchema}, which
 * does the heavy lifting required by task 5.5:
 *
 *   - enforces `exercises.length ≤ 50` (Req 12.2),
 *   - enforces `sets.length ≤ 30` per exercise via the nested
 *     `ExerciseSchema` (Req 12.3),
 *   - bounds `reps` to `[0, 1000]` and rejects negative weights
 *     / durations (schema-level defense in depth),
 *   - rejects unknown fields through `.strict()`,
 *   - allows an optional `studioId` for sessions logged inside a
 *     partner studio (Req 12.1).
 *
 * On success the parsed payload is forwarded to the repo unchanged
 * (type-safe, trimmed, extra-field-free) and the stored session is
 * returned. The repo assigns `id` and `createdAt`.
 *
 * Throws {@link MembersError} with `code = 'validation_failed'` and a
 * normalised `issues` list on any schema violation; the gateway maps
 * that to HTTP 422 with an `application/problem+json` body.
 */
export async function logSession(
  userId: string,
  input: unknown,
  deps: SessionsServiceDeps,
  options: { readonly idempotencyKey?: string | undefined } = {},
): Promise<WorkoutSession> {
  const parsed = LogSessionRequestSchema.safeParse(input);
  if (!parsed.success) {
    const issues = toValidationIssues(parsed.error.issues);
    throw new MembersError(
      'validation_failed',
      formatIssueSummary('invalid workout session', issues),
      issues,
    );
  }

  const { startedAt, durationMin, exercises, notes, cardio, studioId, source } = parsed.data;
  const createInput: CreateWorkoutSessionInput = {
    userId,
    startedAt,
    exercises,
    ...(durationMin === undefined ? {} : { durationMin }),
    ...(notes === undefined ? {} : { notes }),
    ...(cardio === undefined ? {} : { cardio }),
    ...(studioId === undefined ? {} : { studioId }),
    ...(source === undefined ? {} : { source }),
    // An empty key would turn every later key-less retry into a replay.
    ...(options.idempotencyKey === undefined || options.idempotencyKey.length === 0
      ? {}
      : { idempotencyKey: options.idempotencyKey }),
  };
  return deps.repo.create(createInput);
}

/* ------------------------------------------------------------------ */
/*  Use case 2 — list workout sessions                                 */
/* ------------------------------------------------------------------ */

/**
 * Return the workout sessions logged by `userId` within the window
 * described by `rangeInput`.
 *
 * The range is validated through {@link ListSessionsQuerySchema},
 * which carries two refinements lifted straight from the class
 * browsing endpoint: `to > from` (`range_inverted`) and
 * `to - from ≤ 90 days` (`range_too_large`). A malformed or unbounded
 * range is rejected before any I/O happens.
 *
 * The ISO-8601 strings from the parsed query are converted to `Date`
 * instances so the repo can bind them as `timestamptz` parameters
 * without re-parsing. Ordering by `started_at DESC` is the repo's
 * responsibility (Req 12.4); the service only guards the input and
 * caps the page size at {@link LIST_SESSIONS_HARD_LIMIT}.
 *
 * Throws {@link MembersError} with `code = 'validation_failed'` on
 * any schema violation.
 */
export async function listSessions(
  userId: string,
  rangeInput: unknown,
  deps: SessionsServiceDeps,
): Promise<WorkoutSession[]> {
  const parsed = ListSessionsQuerySchema.safeParse(rangeInput);
  if (!parsed.success) {
    const issues = toValidationIssues(parsed.error.issues);
    throw new MembersError(
      'validation_failed',
      formatIssueSummary('invalid session history range', issues),
      issues,
    );
  }

  const from = new Date(parsed.data.from);
  const to = new Date(parsed.data.to);
  return deps.repo.listByUser(userId, {
    from,
    to,
    limit: LIST_SESSIONS_HARD_LIMIT,
  });
}
