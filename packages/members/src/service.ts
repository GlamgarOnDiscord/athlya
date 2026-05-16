/**
 * Members service — profile read/update + listing use cases.
 *
 * This module is the home of the three use cases called out in task 5.1
 * of the Athlya implementation plan:
 *
 *   - {@link getProfile}          — Requirement 3.1.
 *   - {@link updateProfile}       — Requirements 3.2, 3.4 (whitelist +
 *     displayName length bounds [1, 80]).
 *   - {@link listMembersByStudio} — Requirement 3.5 (admin/coach of
 *     the same studio may page through member profiles).
 *
 * The service is deliberately framework-free: it takes a pluggable
 * {@link MemberRepo} (same injection pattern used by `@athlya/auth`'s
 * future service) so the unit tests don't need to reach for Drizzle or
 * a real Postgres instance. The concrete implementation that wires the
 * repo to the `@athlya/db` layer lives outside this package and is
 * assembled by the API gateway (Epic 7).
 *
 * Validation is delegated entirely to the shared Zod schemas exported
 * from `@athlya/shared/schemas/api`, so the server-side rules are bit-
 * for-bit identical to what the web and mobile clients enforce on the
 * way out. Any invalid payload surfaces as a {@link MembersError} with
 * `code = 'validation_failed'` carrying a normalised issue list — the
 * API gateway transforms that into an RFC 7807 Problem Details body
 * (Requirement 14.6).
 */

import {
    UpdateProfileRequestSchema,
    type UpdateProfileRequest,
} from '@athlya/shared/schemas/api';

import type { Consents } from '@athlya/shared/schemas';

/* ------------------------------------------------------------------ */
/*  Domain view types                                                  */
/* ------------------------------------------------------------------ */

/**
 * Role tag attached to every user row. Duplicated here as a plain union
 * (rather than imported from the Zod schema) so this module stays free
 * of any runtime dependency on Zod at the type level.
 */
export type Role = 'member' | 'coach' | 'admin';

/**
 * "Safe" projection of a user row returned by the members API: all the
 * columns of the `users` table except the password hash and the
 * `deletedAt` tombstone, neither of which ever crosses the wire.
 *
 * Shape chosen to match the UserSchema domain model (Requirement 3.1)
 * minus `password_hash` as specified by task 5.1. IDs are kept as plain
 * strings here — callers that need the branded `UserId` / `StudioId`
 * types from `@athlya/shared/ids` can re-brand at the API boundary.
 */
export interface MemberProfile {
    id: string;
    studioId: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    role: Role;
    consents: Consents;
    createdAt: string;
}

/**
 * One page of the admin/coach "list members of my studio" view
 * (Requirement 3.5). `nextCursor` is `null` on the last page.
 */
export interface MembersPage {
    items: MemberProfile[];
    nextCursor: string | null;
}

/* ------------------------------------------------------------------ */
/*  Repository port                                                    */
/* ------------------------------------------------------------------ */

/**
 * Minimal contract the members service needs from the persistence
 * layer. Declared here (as opposed to in `@athlya/db`) so the service
 * owns its own port and so unit tests can provide a trivial in-memory
 * or `vi.fn()` double without pulling Drizzle, Postgres or any network
 * adapter into the test runtime.
 *
 * The concrete implementation lives in the API gateway wiring; it is
 * responsible for wrapping every call in the tenant-aware
 * `withTenant(claims, fn)` transaction helper from `@athlya/db/client`
 * so that RLS (Requirement 13) is applied.
 */
export interface MemberRepo {
    /** Return the profile for `userId`, or `null` if unknown / soft-deleted. */
    findProfile(userId: string): Promise<MemberProfile | null>;

    /**
     * Apply the whitelisted `patch` to the profile for `userId` and
     * return the updated view. The caller has already validated `patch`
     * through {@link UpdateProfileRequestSchema}; the repo must simply
     * persist the supplied fields.
     */
    updateProfile(
        userId: string,
        patch: UpdateProfileRequest,
    ): Promise<MemberProfile>;

    /**
     * Return one page of the member list for the given studio. `cursor`
     * is opaque to the service layer — the repo owns its format. The
     * repo is responsible for enforcing the studio scope (the service
     * only performs the role gate).
     */
    listByStudio(
        studioId: string,
        opts: { cursor?: string; limit: number },
    ): Promise<MembersPage>;
}

/**
 * Dependencies injected into every use case. `now` is exposed for
 * future use cases in this package (consent history, export jobs) and
 * for tests that want to freeze the clock; the three task 5.1 use
 * cases don't read it today but it is part of the shared shape to
 * keep the service signature stable.
 */
export interface MembersServiceDeps {
    repo: MemberRepo;
    /** Defaults to `Date.now`. Supplied explicitly in tests. */
    now?: () => number;
}

/* ------------------------------------------------------------------ */
/*  Typed error                                                        */
/* ------------------------------------------------------------------ */

/**
 * Normalised validation issue surfaced by {@link MembersError} when
 * `code === 'validation_failed'`. Mirrors the shape already used by
 * `@athlya/shared`'s `InvalidEventError` so the API gateway can render
 * a uniform RFC 7807 Problem Details response regardless of which
 * domain surfaced the Zod failure.
 */
export interface MembersValidationIssue {
    /** Dotted path to the offending field, e.g. `displayName`. */
    readonly path: string;
    /** Zod issue code (`invalid_type`, `too_small`, `too_big`, …). */
    readonly code: string;
    /** Human-readable message from the schema. */
    readonly message: string;
}

/**
 * Closed set of machine-readable error codes emitted by the members
 * service. Matches what the API layer turns into Problem Details
 * `type`/`title` slugs.
 */
export type MembersErrorCode = 'not_found' | 'validation_failed' | 'forbidden';

/**
 * Typed error thrown by the members service. The `code` field is
 * stable across API versions; the optional `issues` payload is only
 * present when `code === 'validation_failed'` and carries the
 * normalised Zod issue list.
 */
export class MembersError extends Error {
    public override readonly name = 'MembersError';
    public readonly code: MembersErrorCode;
    public readonly issues: ReadonlyArray<MembersValidationIssue> | undefined;

    public constructor(
        code: MembersErrorCode,
        message?: string,
        issues?: ReadonlyArray<MembersValidationIssue>,
    ) {
        super(message ?? code);
        this.code = code;
        this.issues = issues;
    }
}

/* ------------------------------------------------------------------ */
/*  Limit clamp helper                                                 */
/* ------------------------------------------------------------------ */

/** Default page size for {@link listMembersByStudio}. */
const DEFAULT_LIST_LIMIT = 20;
/** Hard ceiling so a malicious caller can't request the whole studio. */
const MAX_LIST_LIMIT = 100;
/** Hard floor so `limit = 0` or negatives never silently return an
 * empty page. */
const MIN_LIST_LIMIT = 1;

/**
 * Clamp a caller-provided `limit` to `[MIN, MAX]`, substituting the
 * default when `undefined` or non-finite (e.g. `Number.NaN`). Accepts
 * only integers; non-integer values are floored toward zero before
 * clamping so float noise from a URL query parser can't sneak past.
 */
function clampLimit(raw: number | undefined): number {
    if (raw === undefined || !Number.isFinite(raw)) {
        return DEFAULT_LIST_LIMIT;
    }
    const asInt = Math.trunc(raw);
    if (asInt < MIN_LIST_LIMIT) return MIN_LIST_LIMIT;
    if (asInt > MAX_LIST_LIMIT) return MAX_LIST_LIMIT;
    return asInt;
}

/* ------------------------------------------------------------------ */
/*  Use case 1 — read profile                                          */
/* ------------------------------------------------------------------ */

/**
 * Return the profile for `userId`.
 *
 * Throws {@link MembersError} with `code = 'not_found'` when the repo
 * reports no matching row (user was never created, or was soft-deleted
 * via {@link https://… | Requirement 5.1}). The API gateway translates
 * that into HTTP 404 via its Problem Details error middleware.
 *
 * Related requirements: 3.1.
 */
export async function getProfile(
    userId: string,
    deps: MembersServiceDeps,
): Promise<MemberProfile> {
    const profile = await deps.repo.findProfile(userId);
    if (profile === null) {
        throw new MembersError('not_found', `profile not found: ${userId}`);
    }
    return profile;
}

/* ------------------------------------------------------------------ */
/*  Use case 2 — update profile                                        */
/* ------------------------------------------------------------------ */

/**
 * Apply a `PATCH /v1/members/me`-style payload to the profile owned by
 * `userId`.
 *
 * The payload is validated with {@link UpdateProfileRequestSchema},
 * which does the heavy lifting required by task 5.1:
 *
 *   - whitelists only `displayName` and `avatarUrl` (extra fields are
 *     rejected by the strict object) — Requirement 3.2.
 *   - enforces `displayName.length ∈ [1, 80]` after trimming (via the
 *     underlying `UserSchema`) — Requirement 3.4.
 *   - requires at least one of the two fields to be present so we
 *     don't burn a database round-trip on an empty patch.
 *
 * On success the repo is called with the *parsed* patch (type-safe,
 * trimmed) and the updated profile is returned.
 *
 * Throws {@link MembersError} with `code = 'validation_failed'` and a
 * normalised `issues` list on any schema violation; the gateway maps
 * that to HTTP 422 with an `application/problem+json` body.
 */
export async function updateProfile(
    userId: string,
    patch: unknown,
    deps: MembersServiceDeps,
): Promise<MemberProfile> {
    const parsed = UpdateProfileRequestSchema.safeParse(patch);
    if (!parsed.success) {
        const issues: MembersValidationIssue[] = parsed.error.issues.map(
            (issue) => ({
                path: issue.path.map(String).join('.'),
                code: issue.code,
                message: issue.message,
            }),
        );
        throw new MembersError(
            'validation_failed',
            `invalid profile patch: ${issues
                .map((i) => `${i.path || '<root>'} ${i.message}`)
                .join('; ')}`,
            issues,
        );
    }
    return deps.repo.updateProfile(userId, parsed.data);
}

/* ------------------------------------------------------------------ */
/*  Use case 3 — list members of a studio                              */
/* ------------------------------------------------------------------ */

/** Options accepted by {@link listMembersByStudio}. */
export interface ListMembersOptions {
    /** Opaque pagination cursor returned by a previous page. */
    cursor?: string;
    /** Desired page size; clamped to `[1, 100]`, defaults to 20. */
    limit?: number;
}

/**
 * Return one page of the "members of my studio" admin/coach view
 * (Requirement 3.5).
 *
 * The role gate is enforced here, *before* the repo call, so an
 * authenticated `member` never gets to influence the database query at
 * all: a `forbidden` error is thrown before any I/O. The repo is still
 * responsible for scoping results to `studioId`; RLS downstream is the
 * ultimate guarantee (Requirement 13) but defense in depth is cheap.
 */
export async function listMembersByStudio(
    studioId: string,
    requesterRole: Role,
    opts: ListMembersOptions,
    deps: MembersServiceDeps,
): Promise<MembersPage> {
    if (requesterRole !== 'admin' && requesterRole !== 'coach') {
        throw new MembersError(
            'forbidden',
            `role '${requesterRole}' cannot list studio members`,
        );
    }
    const limit = clampLimit(opts.limit);
    const repoOpts: { cursor?: string; limit: number } =
        opts.cursor === undefined ? { limit } : { cursor: opts.cursor, limit };
    return deps.repo.listByStudio(studioId, repoOpts);
}
