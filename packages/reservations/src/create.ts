/**
 * Class creation use case for `@athlya/reservations`.
 *
 * This module implements Requirement 6.1 through 6.4 of the Athlya
 * spec for the Reservations (content-planning) surface:
 *
 *   - 6.1 — persist a new class bound to the admin's studio with
 *           `version = 0`.
 *   - 6.2 — reject `capacity` outside the inclusive range [1, 500].
 *   - 6.3 — reject `durationMin` outside the inclusive range [5, 480].
 *   - 6.4 — reject `startsAt` earlier than the server's current time.
 *
 * The capacity + duration bounds are enforced at the wire boundary by
 * {@link CreateClassRequestSchema} (zod), so this module only has to
 * add the dynamic "in the past" check and the persistence /
 * seat-counter orchestration on top.
 *
 * Architecture notes mirror the rest of `@athlya/reservations`: every
 * persistence, cache and clock concern is expressed as an injected
 * dependency so tests never touch a real database or Redis. A
 * production wiring binds {@link ClassRepo} to a Drizzle query and
 * {@link RemainingCounterWriter} to an Upstash Redis `SET` against the
 * `class:{id}:remaining` key (design.md §"Reservations Service").
 */

import { CreateClassRequestSchema } from '@athlya/shared/schemas/api';

import type { ClassRow } from '@athlya/db/schema';
import type { StudioId, UserId } from '@athlya/shared/ids';
import type { CreateClassRequest } from '@athlya/shared/schemas/api';

/* ------------------------------------------------------------------ */
/*  Public input / error types                                         */
/* ------------------------------------------------------------------ */

/**
 * Payload accepted by {@link createClass}. Structurally identical to
 * {@link CreateClassRequestSchema}'s output — re-exported here as a
 * named alias so callers can import the input type from the domain
 * module rather than reaching back into `@athlya/shared/schemas/api`.
 *
 * Fields:
 *   - `title`       — trimmed, 1..200 chars (enforced by zod).
 *   - `startsAt`    — ISO-8601 timestamp with offset. Requirement 6.4
 *                     additionally requires `startsAt > now()`.
 *   - `durationMin` — integer in [5, 480] (Requirement 6.3).
 *   - `capacity`    — integer in [1, 500] (Requirement 6.2).
 *   - `coachId`     — optional branded `UserId`. Classes without a
 *                     coach are legal (design.md §Component 4).
 */
export type CreateClassInput = CreateClassRequest;

/**
 * Stable machine-readable error codes surfaced by {@link createClass}.
 *
 *   - `validation_failed` — the payload did not match
 *     {@link CreateClassRequestSchema} (bad types, out-of-range
 *     capacity / duration, malformed `startsAt`, …). The gateway
 *     translates this to HTTP 422 with the zod `issues` array in the
 *     Problem Details `errors` field (Requirement 6.2, 6.3).
 *   - `class_in_past`     — `startsAt <= now()` (Requirement 6.4).
 *     Also translated to HTTP 422 but with a dedicated Problem
 *     Details code so the mobile client can show a targeted hint.
 */
export type CreateClassErrorCode = 'validation_failed' | 'class_in_past';

/**
 * Exception thrown by {@link createClass} on any rejected input.
 *
 * `code` is the authoritative identifier the API gateway maps to
 * HTTP status + Problem Details; `issues` carries the raw zod
 * `ZodIssue[]` when `code === 'validation_failed'` so the gateway can
 * surface the field-level paths without a second parse of the body.
 */
export class CreateClassError extends Error {
    public override readonly name = 'CreateClassError';
    public readonly code: CreateClassErrorCode;
    /**
     * zod issues from the failing parse. Populated only when
     * `code === 'validation_failed'`. The field is typed as readonly
     * `unknown[]` to keep this module independent of the exact zod
     * runtime type surface — the API gateway re-validates via the
     * same schema before serialising so it has the proper typing
     * locally.
     */
    public readonly issues: ReadonlyArray<unknown>;

    public constructor(
        code: CreateClassErrorCode,
        message?: string,
        issues: ReadonlyArray<unknown> = [],
    ) {
        super(message ?? code);
        this.code = code;
        this.issues = issues;
    }
}

/* ------------------------------------------------------------------ */
/*  Dependency contracts                                               */
/* ------------------------------------------------------------------ */

/**
 * Row accepted by {@link ClassRepo.createClass}. Mirrors the fields
 * a production Drizzle `insert(classes).values(...)` call takes —
 * `studioId` is provided by the caller (derived from the admin's
 * JWT, never from the request body) and `version` is pinned to `0`
 * at creation time per Requirement 6.1.
 *
 * The repo is responsible for generating `id` (UUID v7) and
 * `createdAt`, and for returning the complete persisted row. Keeping
 * those out of the input type makes tests free to assert the service
 * passes exactly the right shape.
 */
export interface CreateClassRepoInput {
    readonly studioId: StudioId;
    readonly title: string;
    readonly startsAt: string;
    readonly durationMin: number;
    readonly capacity: number;
    readonly coachId?: UserId;
    readonly version: 0;
}

/**
 * Persistence contract for class creation. Kept narrow so a future
 * `ClassRepo` that also exposes list / update operations can extend
 * this interface without forcing every test double to grow extra
 * methods.
 */
export interface ClassRepo {
    /**
     * Insert the row and return the fully populated {@link ClassRow}.
     *
     * The repo owns:
     *   - UUID generation (`id`).
     *   - `createdAt` / `deletedAt` stamping.
     *   - The unique-insert guard — callers do not need to pre-check.
     *
     * Implementations SHOULD propagate any SQL error unchanged; the
     * service layer does not try to remap database-level failures to
     * domain codes at this point (Requirement 6.1 is a happy-path
     * rule; 6.5–6.7 cover the error paths around updates).
     */
    createClass(input: CreateClassRepoInput): Promise<ClassRow>;
}

/**
 * Thin write-side interface over the `class:{id}:remaining` Redis
 * counter that Requirement 7.2 reads from on every class list. The
 * production implementation lives in `@athlya/api`'s Upstash Redis
 * binding; this package stays agnostic of the client.
 */
export interface RemainingCounterWriter {
    /**
     * Idempotently seed `class:{classId}:remaining` to `capacity`.
     *
     * Called exactly once per newly-created class, immediately after
     * the DB insert succeeds. If the Redis `SET` fails the caller
     * surfaces the error: the class is already persisted, but the
     * counter is absent — Requirement 7.2 would then return `0`
     * remaining until the next successful booking / cancellation
     * path rebuilds it. This matches the design.md guidance that the
     * DB, not Redis, is the authoritative source of truth.
     */
    reset(classId: string, capacity: number): Promise<void>;
}

/**
 * Full dependency bundle for {@link createClass}. `now` is injectable
 * so tests can pin the clock and exercise the "startsAt in the past"
 * branch deterministically.
 */
export interface CreateClassDeps {
    readonly classRepo: ClassRepo;
    readonly counter: RemainingCounterWriter;
    /**
     * Injected clock. Defaults to `Date.now`. The service calls it
     * exactly once per invocation — the value is compared as-is
     * against `Date.parse(startsAt)`, so both are Unix-ms.
     */
    readonly now?: () => number;
}

/* ------------------------------------------------------------------ */
/*  Implementation                                                     */
/* ------------------------------------------------------------------ */

/**
 * Create a class for a studio.
 *
 * Sequence (Requirement 6.1–6.4):
 *
 *   1. Parse `input` through {@link CreateClassRequestSchema}. zod
 *      rejects any payload that violates the capacity / duration
 *      bounds, malformed datetimes, unknown fields, etc. Any failure
 *      is rethrown as {@link CreateClassError} with code
 *      `validation_failed` so the gateway never has to import `zod`
 *      just to identify the error surface.
 *   2. Compare the parsed `startsAt` against `deps.now()`. If the
 *      start is at or before "now", throw
 *      {@link CreateClassError} with code `class_in_past`
 *      (Requirement 6.4). The equality branch (`===`) is rejected
 *      too: a class that "starts right now" has no booking runway
 *      and every downstream system (waitlist promotion, reminders,
 *      QR check-in) is built on `startsAt > now`.
 *   3. Insert through {@link ClassRepo.createClass}, pinning
 *      `version` to `0` per Requirement 6.1.
 *   4. Seed the Redis remaining-seats counter via
 *      {@link RemainingCounterWriter.reset}. This is a separate
 *      step — not a DB-side trigger — so testing and on-prem
 *      deployments without Upstash can swap the writer for an
 *      in-memory map without touching the persistence layer.
 *
 * @throws {@link CreateClassError} with `validation_failed` or
 *   `class_in_past`.
 */
export async function createClass(
    studioId: StudioId,
    input: unknown,
    deps: CreateClassDeps,
): Promise<ClassRow> {
    // ---- Step 1: wire-level validation -----------------------------------
    const parseResult = CreateClassRequestSchema.safeParse(input);
    if (!parseResult.success) {
        throw new CreateClassError(
            'validation_failed',
            'createClass: payload failed schema validation',
            parseResult.error.issues,
        );
    }
    const parsed: CreateClassInput = parseResult.data;

    // ---- Step 2: dynamic "not in the past" check (Requirement 6.4) -------
    const nowMs = (deps.now ?? defaultNow)();
    const startsAtMs = Date.parse(parsed.startsAt);
    if (!(startsAtMs > nowMs)) {
        throw new CreateClassError(
            'class_in_past',
            `createClass: startsAt (${parsed.startsAt}) is not strictly in the future`,
        );
    }

    // ---- Step 3: persist with version = 0 (Requirement 6.1) --------------
    //
    // `coachId` is conditionally included so the repo sees an
    // absent property rather than `undefined`, matching Drizzle's
    // default-column semantics. `version` is pinned here — callers
    // cannot override it.
    const repoInput: CreateClassRepoInput = {
        studioId,
        title: parsed.title,
        startsAt: parsed.startsAt,
        durationMin: parsed.durationMin,
        capacity: parsed.capacity,
        version: 0,
        ...(parsed.coachId !== undefined ? { coachId: parsed.coachId } : {}),
    };
    const row = await deps.classRepo.createClass(repoInput);

    // ---- Step 4: seed the Redis remaining-seats counter ------------------
    //
    // Ordered strictly AFTER the DB write: if the insert rolls back
    // we must not leave a dangling counter, and if the counter write
    // fails the caller can still observe the persisted row and
    // decide how to recover (e.g. retry the seed from a background
    // job). The production API layer wraps this call in the same
    // trace span as the insert for observability.
    await deps.counter.reset(row.id, row.capacity);

    return row;
}

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                   */
/* ------------------------------------------------------------------ */

function defaultNow(): number {
    return Date.now();
}
