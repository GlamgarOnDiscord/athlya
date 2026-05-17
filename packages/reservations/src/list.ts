/**
 * Class listing use case for the Reservations service.
 *
 * Implements task 6.1 and satisfies Requirement 7:
 *
 *   - 7.1 — Return every non-deleted class of the member's studio whose
 *     `startsAt` falls in the requested `[from, to]` window, ordered by
 *     `startsAt ASC`. Ordering is delegated to the repository because
 *     the `classes_studio_starts_at_idx` composite index on
 *     `(studio_id, starts_at)` already sorts reads in the right order
 *     — there's no reason to re-sort in JavaScript.
 *   - 7.2 — Include each class's current `remaining` seat count read
 *     from the Redis counter (`class:{id}:remaining`). When the key is
 *     missing — typically because the class was just created and the
 *     seed write in task 6.2 has not yet landed — we fall back to
 *     `capacity`, which is a safe upper bound.
 *   - 7.3 — Reject ranges longer than 90 days with `range_too_large`
 *     (and inverted ranges with `range_inverted`). Both refinements
 *     are already carried by `ListClassesQuerySchema` in
 *     `@athlya/shared/schemas/api`; we re-use that schema to avoid
 *     drift and translate its issue codes to
 *     {@link ClassListError} instances the API gateway can render as
 *     Problem Details (Requirement 14.6).
 *
 * The module is framework-free: it depends only on a pluggable
 * {@link ClassRepo} (tenant-scoped SQL — wired by the API gateway to
 * a Drizzle implementation that runs under `withTenant`) and a
 * {@link RemainingCounterReader} (usually backed by
 * `createRedisRemainingCounter`). That keeps the unit tests trivial
 * and mirrors the pattern established by `@athlya/members`.
 */

import { ListClassesQuerySchema } from '@athlya/shared/schemas/api';

import type { RemainingCounterReader } from './counter.js';
import type { ClassWithRemaining } from '@athlya/shared/schemas/api';

/* ------------------------------------------------------------------ */
/*  Error type                                                         */
/* ------------------------------------------------------------------ */

/**
 * Stable machine-readable codes surfaced by {@link ClassListError}.
 *
 *   - `range_inverted` — `to <= from`. Not called out by Req 7 but
 *     `ListClassesQuerySchema` already rejects it and carries the
 *     code through its `params`; we forward it verbatim so the API
 *     gateway can render a deterministic Problem Details response.
 *   - `range_too_large` — `to - from > 90 days`. Req 7.3.
 *   - `invalid_range` — any other shape violation on the query object
 *     (missing field, non-ISO string, …). Acts as a catch-all so the
 *     use case never leaks a raw `ZodError` through its contract.
 */
export type ClassListErrorCode = 'range_inverted' | 'range_too_large' | 'invalid_range';

/**
 * Lightweight issue shape we attach to {@link ClassListError.issues}.
 * Matches the convention used by `MembersError` so the API gateway
 * can keep a single Problem Details renderer for both.
 */
export interface ClassListValidationIssue {
  /** Dot-joined Zod path, empty string for the root object. */
  path: string;
  /** Zod issue `code` (e.g. `invalid_string`, `custom`). */
  code: string;
  /** Human-readable message. */
  message: string;
}

/**
 * Error thrown by {@link listClasses} when the caller-supplied range
 * fails validation. The API gateway translates this into a 422
 * `application/problem+json` response using `code` as the Problem
 * Details `title` / `code` slug.
 */
export class ClassListError extends Error {
  public readonly code: ClassListErrorCode;
  public readonly issues: readonly ClassListValidationIssue[];

  public constructor(
    code: ClassListErrorCode,
    message: string,
    issues: readonly ClassListValidationIssue[] = [],
  ) {
    super(message);
    this.name = 'ClassListError';
    this.code = code;
    this.issues = issues;
  }
}

/* ------------------------------------------------------------------ */
/*  Repository port                                                    */
/* ------------------------------------------------------------------ */

/**
 * Plain row shape returned by {@link ClassRepo.findInRange}. The
 * fields mirror the `classes` table columns used by this use case —
 * `startsAt` is kept as a `Date` because the Drizzle schema declares
 * the column with `mode: 'date'` (see `@athlya/db/schema/classes.ts`)
 * and converting here would force a useless allocation. The service
 * converts to ISO-8601 once when building the wire response.
 *
 * `ClassRow` is intentionally decoupled from `ClassSchema` in
 * `@athlya/shared/schemas/domain` (which carries `startsAt` as an
 * ISO string) so repos can return their native types without a
 * round-trip through the codec layer.
 */
export interface ClassRow {
  id: string;
  studioId: string;
  coachId: string | null;
  title: string;
  startsAt: Date;
  durationMin: number;
  capacity: number;
  version: number;
  createdAt: Date;
}

/**
 * Input shape passed to {@link ClassRepo.findInRange}. The service
 * always passes both `from` and `to` as `Date` instances converted
 * from the already-validated ISO-8601 query strings.
 */
export interface FindInRangeRange {
  from: Date;
  to: Date;
}

/**
 * Minimal contract the class-listing use case needs from the
 * persistence layer.
 *
 * Declared here (rather than in `@athlya/db`) so the service owns its
 * own port and so unit tests can provide a trivial `vi.fn()` double
 * without pulling Drizzle or Postgres into the test runtime. The
 * concrete implementation lives in the API gateway wiring and is
 * responsible for:
 *
 *   - running under `withTenant(claims, fn)` so RLS is enforced
 *     (Requirement 13);
 *   - filtering out `deleted_at IS NOT NULL` rows (Req 7.1);
 *   - returning rows ordered `starts_at ASC` — the
 *     `classes_studio_starts_at_idx` index already serves this
 *     ordering, so no extra `ORDER BY` cost is incurred.
 */
export interface ClassRepo {
  findInRange(studioId: string, range: FindInRangeRange): Promise<ClassRow[]>;
}

/* ------------------------------------------------------------------ */
/*  Service dependencies and output type                               */
/* ------------------------------------------------------------------ */

/**
 * Dependencies injected into {@link listClasses}.
 */
export interface ListClassesDeps {
  readonly classRepo: ClassRepo;
  readonly counter: RemainingCounterReader;
}

/**
 * One item in the response produced by {@link listClasses}. Matches
 * `ClassWithRemainingSchema` from `@athlya/shared/schemas/api` field
 * for field so the gateway can serialise the result without a codec
 * round-trip. `startsAt` / `createdAt` are ISO-8601 strings here; the
 * conversion from `Date` happens inside {@link listClasses}.
 */
export type ClassListing = ClassWithRemaining;

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Convert a Zod issue list into the normalised
 * {@link ClassListValidationIssue} shape.
 */
function toValidationIssues(
  issues: ReadonlyArray<{
    path: ReadonlyArray<PropertyKey>;
    code: string;
    message: string;
  }>,
): ClassListValidationIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    code: issue.code,
    message: issue.message,
  }));
}

/**
 * Inspect a Zod issue list and pick the most specific
 * {@link ClassListErrorCode}.
 *
 * Decision order:
 *   1. If any issue is a "primary" validation failure (missing field,
 *      non-ISO string, unknown key, …), return `'invalid_range'`.
 *      The refinements on `ListClassesQuerySchema` run even when
 *      base-type parsing fails — the `(to > from)` check sees `NaN`
 *      from `Date.parse('not-a-date')` and falsely flags the range as
 *      inverted. Treating primary failures as the root cause is
 *      correct and spares clients from chasing a phantom
 *      `range_inverted` error.
 *   2. Otherwise, if the `range_inverted` refinement tripped, return
 *      that code — it's a strictly more actionable diagnostic than
 *      `range_too_large` (a > 90-day span on an inverted window is a
 *      meaningless derived fact).
 *   3. Otherwise, if the `range_too_large` refinement tripped, return
 *      that code (Requirement 7.3).
 *   4. Fallback: `'invalid_range'`.
 *
 * The shared `ListClassesQuerySchema` attaches
 * `params.code = 'range_inverted' | 'range_too_large'` to its custom
 * refinements (see `refineDateRange` in `@athlya/shared/schemas/api`);
 * we match on those opaque strings rather than on `issue.code` so
 * this helper stays forward-compatible with Zod v4 shape changes.
 */
function pickErrorCode(issues: ReadonlyArray<unknown>): ClassListErrorCode {
  let sawInverted = false;
  let sawTooLarge = false;
  let sawPrimaryFailure = false;

  for (const issue of issues) {
    const paramCode = extractParamCode(issue);
    if (paramCode === 'range_inverted') {
      sawInverted = true;
      continue;
    }
    if (paramCode === 'range_too_large') {
      sawTooLarge = true;
      continue;
    }
    // Any issue WITHOUT a `params.code` is a primary (shape) failure:
    // missing field, non-ISO string, unknown key, wrong type.
    sawPrimaryFailure = true;
  }

  if (sawPrimaryFailure) return 'invalid_range';
  if (sawInverted) return 'range_inverted';
  if (sawTooLarge) return 'range_too_large';
  return 'invalid_range';
}

/**
 * Pluck the `params.code` slot off a Zod issue without coupling to
 * Zod's internal issue-type union — Zod 4's discriminated union uses
 * a different shape per variant, but every variant carries the
 * optional `params` record under the same name. A narrow structural
 * read keeps this helper forward-compatible.
 */
function extractParamCode(issue: unknown): string | undefined {
  if (typeof issue !== 'object' || issue === null) return undefined;
  const params = (issue as { params?: unknown }).params;
  if (typeof params !== 'object' || params === null) return undefined;
  const code = (params as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/* ------------------------------------------------------------------ */
/*  Use case                                                           */
/* ------------------------------------------------------------------ */

/**
 * Return the class listing for `studioId` over the requested window.
 *
 * Flow:
 *   1. Validate `rangeInput` through `ListClassesQuerySchema`. The
 *      schema carries the Req 7.3 refinements (`to > from`,
 *      `to - from ≤ 90 days`) plus the base ISO-8601 shape check.
 *   2. Hand the (from, to) `Date` pair to the repo, which returns
 *      rows already ordered `starts_at ASC` (Req 7.1).
 *   3. For each row, read the Redis counter. `null` → fall back to
 *      `row.capacity` (Req 7.2 — the counter may simply not be seeded
 *      yet). A `null` value has the same semantics as "no bookings
 *      yet", which is what `capacity` conveys.
 *   4. Map rows to the wire shape `ClassWithRemaining` (ISO-8601
 *      strings for timestamps).
 *
 * Throws {@link ClassListError} with the appropriate code on any
 * validation failure. The repo's errors bubble up unchanged — the
 * API gateway's global error handler (task 8.5) turns them into
 * Problem Details responses.
 */
export async function listClasses(
  studioId: string,
  rangeInput: unknown,
  deps: ListClassesDeps,
): Promise<ClassListing[]> {
  const parsed = ListClassesQuerySchema.safeParse(rangeInput);
  if (!parsed.success) {
    const issues = toValidationIssues(parsed.error.issues);
    const code = pickErrorCode(parsed.error.issues);
    const message =
      code === 'range_too_large'
        ? 'class list range exceeds the 90-day limit'
        : code === 'range_inverted'
          ? 'class list range must have to > from'
          : `invalid class list range: ${issues
              .map((i) => `${i.path || '<root>'} ${i.message}`)
              .join('; ')}`;
    throw new ClassListError(code, message, issues);
  }

  const from = new Date(parsed.data.from);
  const to = new Date(parsed.data.to);

  const rows = await deps.classRepo.findInRange(studioId, { from, to });
  if (rows.length === 0) {
    return [];
  }

  // Kick off every counter read in parallel. The listing endpoint is
  // latency-sensitive (Req 27.1 ties calendar reads to the p95 budget)
  // and the counter reads are independent, so serialising them would
  // be a pure waste of wall-clock time — especially in the edge
  // runtime where round-trip cost dominates.
  const remainings = await Promise.all(
    rows.map(async (row) => {
      const remote = await deps.counter.getRemaining(row.id);
      return remote ?? row.capacity;
    }),
  );

  return rows.map((row, index) => ({
    id: row.id,
    studioId: row.studioId,
    coachId: row.coachId,
    title: row.title,
    startsAt: row.startsAt.toISOString(),
    durationMin: row.durationMin,
    capacity: row.capacity,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    // `remaining` is clamped at 0 because Redis can transiently
    // hold a negative value between a losing `DECR` and its
    // compensating `INCR` (Algorithm 1). Surfacing a negative
    // number through the public API would violate the
    // `nonnegative()` refinement on `ClassWithRemainingSchema`.
    remaining: Math.max(0, remainings[index] ?? row.capacity),
  })) as ClassListing[];
}
