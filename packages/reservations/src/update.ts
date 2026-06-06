/**
 * Admin-only class update use case with optimistic locking and
 * Redis-counter resynchronisation.
 *
 * Task 6.3 of the Athlya implementation plan. Translates Requirement
 * 6.5–6.7 into a framework-free service function:
 *
 *   - 6.5 — only admins can edit a class (role gate runs *before* any
 *     other work, so a member's payload never even gets validated).
 *   - 6.6 — every UPDATE carries a `version` guard: the SQL statement
 *     `UPDATE classes ... WHERE id = $1 AND version = $2` affects zero
 *     rows when the client echoed a stale counter, which the service
 *     surfaces as a typed `conflict` error (mapped to HTTP 409 by the
 *     gateway).
 *   - 6.7 — a successful UPDATE bumps `version` by exactly 1. The
 *     implementation lives inside the repo adapter; the service just
 *     returns the row it gets back and trusts the repo to have done so.
 *
 * The module follows the same dependency-injection style used in
 * `@athlya/members/service`: a minimal `ClassRepo` port and a
 * framework-free `Counter` port, both wired to `@athlya/db` and
 * `@athlya/api`'s Redis bindings at the API gateway layer. That keeps
 * unit tests free of Drizzle, Postgres and Upstash while still
 * exercising the full service logic with `vi.fn()` doubles.
 *
 * Validation is delegated to the shared `UpdateClassRequestSchema` from
 * `@athlya/shared/schemas/api`, so the server-side rules are bit-for-
 * bit identical to what the web and mobile clients enforce. Any
 * invalid payload surfaces as an {@link UpdateClassError} with
 * `code = 'validation_failed'` carrying a normalised issue list — the
 * API gateway transforms that into an RFC 7807 Problem Details body
 * (Requirement 14.6).
 */

import { UpdateClassRequestSchema, type UpdateClassRequest } from '@athlya/shared/schemas/api';

import type { ClassRow } from '@athlya/db/schema';

/* ------------------------------------------------------------------ */
/*  Domain view types                                                  */
/* ------------------------------------------------------------------ */

/**
 * Role tag attached to every user row. Duplicated here as a plain
 * union (rather than imported from the Zod schema) so this module
 * stays free of any runtime dependency on Zod at the type level.
 * Mirrors the `Role` type used across the other domain services.
 */
export type Role = 'member' | 'coach' | 'admin';

/**
 * Patch shape accepted by {@link updateClass}. Exactly mirrors
 * `UpdateClassRequestSchema` from `@athlya/shared/schemas/api`:
 *
 *   - `version` is mandatory — it is the optimistic-lock counter the
 *     caller read when it last fetched the class (Requirement 6.6).
 *   - every other field is optional, and the schema additionally
 *     requires that *at least one* mutable field is supplied.
 *
 * Re-exported as a distinct name so downstream packages can import
 * it from `@athlya/reservations/update` without pulling the entire
 * Zod schema surface from `@athlya/shared`.
 */
export type UpdateClassPatch = UpdateClassRequest;

/**
 * Mutable fields only — the {@link UpdateClassPatch} with the
 * `version` guard stripped. This is what the repo's SQL UPDATE sets.
 */
export type UpdateClassFields = Omit<UpdateClassPatch, 'version'>;

/* ------------------------------------------------------------------ */
/*  Repository port                                                    */
/* ------------------------------------------------------------------ */

/**
 * Minimal contract the update use case needs from the persistence
 * layer. Declared here (as opposed to in `@athlya/db`) so the service
 * owns its own port and so unit tests can provide a trivial
 * `vi.fn()` double without pulling Drizzle, Postgres or any network
 * adapter into the test runtime.
 *
 * The concrete implementation lives in the API gateway wiring; it is
 * responsible for wrapping every call in the tenant-aware
 * `withTenant(claims, fn)` transaction helper from `@athlya/db/client`
 * so that RLS (Requirement 13) is applied.
 */
export interface ClassRepo {
  /**
   * Return the class row for `classId`, or `null` if unknown /
   * soft-deleted. Used for the pre-flight existence check so the
   * service can distinguish `not_found` (row is missing) from
   * `conflict` (row exists but version is stale).
   */
  findById(classId: string, studioId: string): Promise<ClassRow | null>;

  /**
   * Apply the mutable `patch` to the class identified by `classId`
   * **only if** its current `version` column equals
   * `expectedVersion`. Returns the updated row on success and
   * `null` when the optimistic-lock guard failed (0 rows affected).
   *
   * Implementations MUST issue a single statement of the form
   *
   *     UPDATE classes
   *     SET <patch>, version = version + 1
   *     WHERE id = $1 AND version = $2
   *     RETURNING *
   *
   * so the `version` bump (Requirement 6.7) and the guard are both
   * enforced atomically by the database.
   */
  updateClassOptimistic(
    classId: string,
    studioId: string,
    patch: UpdateClassFields,
    expectedVersion: number,
  ): Promise<ClassRow | null>;
}

/**
 * Side-channel the service uses to keep the Redis-backed seat
 * counter (`class:{id}:remaining`, see task 6.1) in sync when an
 * admin changes a class's capacity. The contract is deliberately
 * narrow so the test double can reset to any integer without
 * pulling Upstash into the test runtime.
 *
 * The implementation — living in `@athlya/api` — is responsible for
 * executing `SET class:{classId}:remaining = capacity` atomically;
 * the service only asks "please reset the counter for this class to
 * this value".
 */
export interface ClassCounter {
  /**
   * Overwrite the remaining-seats counter for `classId` to
   * `capacity`. Called from {@link updateClass} only when the patch
   * changed `capacity` (Requirement 6.7 — "recompute Redis counter
   * if capacity changed").
   */
  reset(classId: string, capacity: number): Promise<void>;
}

/**
 * Dependencies injected into {@link updateClass}. `now` is exposed
 * for parity with the other services in this package (and for tests
 * that want to freeze the clock); the task 6.3 use case does not
 * read it today but it is part of the shared shape to keep the
 * service signature stable.
 */
export interface UpdateClassDeps {
  classRepo: ClassRepo;
  counter: ClassCounter;
  /** Defaults to `Date.now`. Supplied explicitly in tests. */
  now?: () => number;
}

/* ------------------------------------------------------------------ */
/*  Typed error                                                        */
/* ------------------------------------------------------------------ */

/**
 * Normalised validation issue surfaced by {@link UpdateClassError}
 * when `code === 'validation_failed'`. Mirrors the shape used by
 * `MembersError` so the API gateway can render a uniform RFC 7807
 * Problem Details response regardless of which domain surfaced the
 * Zod failure.
 */
export interface UpdateClassValidationIssue {
  /** Dotted path to the offending field, e.g. `capacity`. */
  readonly path: string;
  /** Zod issue code (`invalid_type`, `too_small`, `too_big`, …). */
  readonly code: string;
  /** Human-readable message from the schema. */
  readonly message: string;
}

/**
 * Closed set of machine-readable error codes emitted by
 * {@link updateClass}. Matches what the API layer turns into
 * Problem Details `type`/`title` slugs and HTTP status codes:
 *
 *   - `forbidden`         → 403 (Requirement 6.5).
 *   - `validation_failed` → 422 (Requirement 14.2, 14.6).
 *   - `not_found`         → 404 (row missing, or cross-tenant via RLS).
 *   - `conflict`          → 409 (stale `version`, Requirement 6.6).
 */
export type UpdateClassErrorCode = 'forbidden' | 'validation_failed' | 'not_found' | 'conflict';

/**
 * Typed error thrown by {@link updateClass}. The `code` field is
 * stable across API versions; the optional `issues` payload is only
 * present when `code === 'validation_failed'` and carries the
 * normalised Zod issue list.
 */
export class UpdateClassError extends Error {
  public override readonly name = 'UpdateClassError';
  public readonly code: UpdateClassErrorCode;
  public readonly issues: ReadonlyArray<UpdateClassValidationIssue> | undefined;

  public constructor(
    code: UpdateClassErrorCode,
    message?: string,
    issues?: ReadonlyArray<UpdateClassValidationIssue>,
  ) {
    super(message ?? code);
    this.code = code;
    this.issues = issues;
  }
}

/* ------------------------------------------------------------------ */
/*  Use case — admin-only class update                                 */
/* ------------------------------------------------------------------ */

/**
 * Admin-only `PATCH /v1/classes/{id}` use case.
 *
 * Control flow, in the exact order required by the task:
 *
 *   1. Role gate — {@link Role} other than `'admin'` is rejected with
 *      `forbidden` **before** any other work (Requirement 6.5). No
 *      repo call, no schema validation: a member's payload never
 *      influences anything downstream, which limits the blast radius
 *      of a role-confusion bug.
 *   2. Zod validation via {@link UpdateClassRequestSchema}. Any
 *      violation surfaces as `validation_failed` with a normalised
 *      issue list. The schema itself enforces:
 *        - `version` is a non-negative integer (Requirement 6.6),
 *        - at least one mutable field is present,
 *        - per-field bounds (title, durationMin, capacity, …) —
 *          Requirements 6.1–6.4 applied to the patch shape.
 *   3. Existence pre-flight via `classRepo.findById`. A `null` result
 *      is surfaced as `not_found` (HTTP 404). This pre-flight also
 *      gives us the current `capacity`, which we need in step 5.
 *   4. Optimistic UPDATE via `classRepo.updateClassOptimistic`. A
 *      `null` return means the DB UPDATE affected 0 rows, i.e. the
 *      caller's `expectedVersion` was stale → `conflict` (HTTP 409,
 *      Requirement 6.6). The repo is also responsible for bumping
 *      `version` by 1 on success (Requirement 6.7).
 *   5. Redis-counter reconciliation — only when the patch actually
 *      **changed** `capacity` (Requirement 6.7: "recompute Redis
 *      counter if capacity changed"). We compare against the row we
 *      just loaded in step 3, so the conditional is correct even if
 *      the caller echoes the same value. The reset runs *after* the
 *      DB write has committed, so a Redis hiccup can never leave the
 *      DB in an inconsistent state (it merely leaves the counter
 *      temporarily stale, which the drain job is designed to heal).
 *   6. Return the updated row; the gateway serialises it with the
 *      shared codec.
 *
 * Related requirements: 6.5, 6.6, 6.7.
 */
export async function updateClass(
  classId: string,
  studioId: string,
  patch: unknown,
  requesterRole: Role,
  deps: UpdateClassDeps,
): Promise<ClassRow> {
  // 1 — role gate, runs before validation so the caller can't force
  //     us to spend CPU parsing a payload they aren't allowed to send.
  if (requesterRole !== 'admin') {
    throw new UpdateClassError('forbidden', `role '${requesterRole}' cannot update classes`);
  }

  // 2 — schema validation. `.safeParse` keeps the error handling
  //     local to this module instead of letting a raw ZodError
  //     escape to the API layer.
  const parsed = UpdateClassRequestSchema.safeParse(patch);
  if (!parsed.success) {
    const issues: UpdateClassValidationIssue[] = parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      code: issue.code,
      message: issue.message,
    }));
    throw new UpdateClassError(
      'validation_failed',
      `invalid class patch: ${issues.map((i) => `${i.path || '<root>'} ${i.message}`).join('; ')}`,
      issues,
    );
  }

  // Split the guarded `version` off from the mutable fields. The
  // destructuring keeps the repo contract narrow: `version` is the
  // optimistic-lock token, never a payload column.
  const { version: expectedVersion, ...fields } = parsed.data;

  // 3 — existence pre-flight. We could fold this into the UPDATE,
  //     but the separate read lets us distinguish `not_found` (no
  //     row at all) from `conflict` (row exists, version mismatch)
  //     which the API caller genuinely needs to act on differently.
  const existing = await deps.classRepo.findById(classId, studioId);
  if (existing === null) {
    throw new UpdateClassError('not_found', `class not found: ${classId}`);
  }

  // 4 — optimistic UPDATE. The repo returns `null` when the DB
  //     reports 0 rows affected, which we translate to `conflict`
  //     (Requirement 6.6 — "0 rows affected → 409 Conflict").
  const updated = await deps.classRepo.updateClassOptimistic(
    classId,
    studioId,
    fields,
    expectedVersion,
  );
  if (updated === null) {
    throw new UpdateClassError(
      'conflict',
      `class ${classId} has a newer version; expected ${expectedVersion}`,
    );
  }

  // 5 — Redis counter reconciliation. Runs *after* the DB commit so
  //     a Redis failure can never roll back a successful SQL write
  //     (Requirement 6.7 recomputes "if capacity changed").
  if (fields.capacity !== undefined && fields.capacity !== existing.capacity) {
    await deps.counter.reset(classId, fields.capacity);
  }

  // 6 — return the updated row for the gateway to serialise.
  return updated;
}
