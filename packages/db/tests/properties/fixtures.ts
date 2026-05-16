/**
 * Shared fixtures and fast-check arbitraries for the RLS property tests.
 *
 * The tenant-isolation property (task 2.7 / Property 7) needs:
 *
 *   - a pair of non-equal studio ids,
 *   - one user owned by each studio,
 *   - a `classes` row owned by each studio,
 *   - a `reservations` row owned by each user, linked to its owner's
 *     class.
 *
 * Keeping the generators in a dedicated module (rather than inlining
 * them in the test file) means the forthcoming booking / cancellation
 * property suites (tasks 6.8–6.10) can reuse the same shapes without
 * duplicating the RFC 4122 patterns or the seed fields.
 *
 * Every arbitrary here is pure data — no I/O, no DB writes. The test
 * file is responsible for turning an `IsolationScenario` into rows via
 * a `postgres`-js client opened against a Testcontainers-managed
 * Postgres instance.
 */

import fc from 'fast-check';

import type { TenantRole } from '../../src/client.js';

/**
 * UUID v4 arbitrary. We intentionally re-use fast-check's built-in so
 * shrinks stay inside the UUID domain — a random 36-char string shrink
 * would make counter-examples much harder to read.
 */
export const uuidArb = fc.uuid({ version: 4 });

/** The three RBAC roles the tenant middleware accepts. */
export const roleArb: fc.Arbitrary<TenantRole> = fc.constantFrom<TenantRole>(
    'member',
    'coach',
    'admin',
);

/**
 * Studio seed — minimal columns required by the `studios` schema:
 * `slug` (unique, url-safe) and `name`. Slugs are drawn from a narrow
 * alphabet + the id suffix to guarantee uniqueness across generated
 * pairs without needing fast-check's `fc.uniqueArray` shrinker gymnastics.
 */
export interface StudioSeed {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
}

export const studioArb: fc.Arbitrary<StudioSeed> = uuidArb.map((id) => ({
    id,
    // Slugs include the uuid so every generated studio is guaranteed
    // unique even when fast-check replays the same base id across runs.
    slug: `studio-${id.slice(0, 8)}`,
    name: `Studio ${id.slice(0, 4)}`,
}));

/**
 * Email arbitrary — keeps the alphabet tight so shrinks produce
 * legible counter-examples like `u-abc12345@athlya.test` rather than
 * full Unicode garbage.
 */
const emailLocalArb = fc
    .stringMatching(/^[a-z0-9]{3,16}$/)
    .filter((s) => s.length >= 3);

/**
 * User seed. `studioId` is set by the scenario builder (never by the
 * arbitrary) to guarantee the user belongs to a specific studio. Role
 * is drawn independently so the test can exercise both member-scoped
 * and admin-scoped queries.
 */
export interface UserSeed {
    readonly id: string;
    readonly studioId: string;
    readonly email: string;
    readonly displayName: string;
    readonly role: TenantRole;
}

export interface UserSeedBase {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly role: TenantRole;
}

export const userSeedBaseArb: fc.Arbitrary<UserSeedBase> = fc
    .tuple(uuidArb, emailLocalArb, roleArb)
    .map(([id, local, role]) => ({
        id,
        email: `${local}-${id.slice(0, 8)}@athlya.test`,
        displayName: `User ${id.slice(0, 4)}`,
        role,
    }));

/**
 * Class seed. `studioId` is filled in by the scenario builder.
 * `startsAt` is a fixed far-future ISO string — the RLS policies we
 * test do not depend on the timestamp.
 */
export interface ClassSeed {
    readonly id: string;
    readonly studioId: string;
    readonly title: string;
    readonly startsAt: string;
    readonly durationMin: number;
    readonly capacity: number;
}

export interface ClassSeedBase {
    readonly id: string;
    readonly title: string;
    readonly durationMin: number;
    readonly capacity: number;
}

export const classSeedBaseArb: fc.Arbitrary<ClassSeedBase> = fc
    .tuple(
        uuidArb,
        fc.integer({ min: 15, max: 120 }),
        fc.integer({ min: 1, max: 50 }),
    )
    .map(([id, durationMin, capacity]) => ({
        id,
        title: `Class ${id.slice(0, 4)}`,
        durationMin,
        capacity,
    }));

/**
 * Reservation seed. `classId` and `userId` are filled in by the
 * scenario builder so the reservation always links an owner-user to
 * an owner-class.
 */
export interface ReservationSeed {
    readonly id: string;
    readonly classId: string;
    readonly userId: string;
}

export const reservationIdArb = uuidArb;

/**
 * A fully resolved isolation scenario — two disjoint tenants each
 * carrying a user, a class and a reservation. Produced by combining
 * the building-block arbitraries above and then wiring foreign keys.
 *
 * The `preconditions` field flags cases the test must `fc.pre()` out,
 * in particular when the two studios or users happen to share ids
 * (fast-check's default generator is uniform so collisions are rare
 * but not impossible — skipping them keeps the property's meaning
 * crystal clear).
 */
export interface IsolationScenario {
    readonly studioA: StudioSeed;
    readonly studioB: StudioSeed;
    readonly userA: UserSeed;
    readonly userB: UserSeed;
    readonly classA: ClassSeed;
    readonly classB: ClassSeed;
    readonly reservationA: ReservationSeed;
    readonly reservationB: ReservationSeed;
}

/**
 * Builds an `IsolationScenario` by composing the primitive arbitraries.
 *
 * Two key points:
 *
 *   1. All ids are drawn independently. The test's `fc.pre()` filter
 *      drops samples where cross-tenant ids happen to collide (user A
 *      id == user B id, etc.). Pre-conditions on independent uniform
 *      uuidv4 draws reject with probability ~0, so this does not
 *      impact the effective run count.
 *   2. Foreign keys are wired up *after* the arbitraries draw:
 *      `userA.studioId === studioA.id`, `classA.studioId === studioA.id`,
 *      `reservationA.classId === classA.id`, `reservationA.userId
 *      === userA.id`, and symmetrically for B. This is the shape the
 *      test seeds into Postgres; RLS policies should then forbid user
 *      A from seeing any B-owned row.
 */
export const isolationScenarioArb: fc.Arbitrary<IsolationScenario> = fc
    .record({
        studioA: studioArb,
        studioB: studioArb,
        userABase: userSeedBaseArb,
        userBBase: userSeedBaseArb,
        classABase: classSeedBaseArb,
        classBBase: classSeedBaseArb,
        reservationAId: reservationIdArb,
        reservationBId: reservationIdArb,
    })
    .map(
        ({
            studioA,
            studioB,
            userABase,
            userBBase,
            classABase,
            classBBase,
            reservationAId,
            reservationBId,
        }) => ({
            studioA,
            studioB,
            userA: { ...userABase, studioId: studioA.id },
            userB: { ...userBBase, studioId: studioB.id },
            classA: {
                ...classABase,
                studioId: studioA.id,
                startsAt: '2030-01-01T09:00:00Z',
            },
            classB: {
                ...classBBase,
                studioId: studioB.id,
                startsAt: '2030-01-01T19:00:00Z',
            },
            reservationA: {
                id: reservationAId,
                classId: classABase.id,
                userId: userABase.id,
            },
            reservationB: {
                id: reservationBId,
                classId: classBBase.id,
                userId: userBBase.id,
            },
        }),
    );

/**
 * Rejects scenarios whose cross-tenant ids happen to coincide. A
 * collision would make the "cross-tenant read is empty" property
 * vacuous (or ill-defined) because the row queried on one side would
 * also exist on the other. With uuidv4 draws the filter rejects with
 * probability ~0 but we keep the guard explicit so failures remain
 * easy to interpret.
 */
export function scenarioIdsAllDistinct(s: IsolationScenario): boolean {
    const ids = [
        s.studioA.id,
        s.studioB.id,
        s.userA.id,
        s.userB.id,
        s.classA.id,
        s.classB.id,
        s.reservationA.id,
        s.reservationB.id,
    ];
    return new Set(ids).size === ids.length;
}

/** Versioned consents JSON payload — shape documented by `ConsentsSchema`. */
export const DEFAULT_CONSENTS_JSON = {
    marketing: false,
    analytics: false,
    thirdParty: false,
    version: 1,
    updatedAt: '2030-01-01T00:00:00Z',
} as const;
