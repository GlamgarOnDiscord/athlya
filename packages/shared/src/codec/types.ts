/**
 * Wire types — the over-the-wire JSON shape of every domain model crossing
 * the Athlya API boundary.
 *
 * These types exist alongside the domain types (re-exported from
 * `@athlya/shared/schemas/domain`) for a single reason: they make the codec
 * contract visible at the type level. Today the on-the-wire representation
 * and the domain representation are nearly identical because Athlya stores
 * timestamps as ISO-8601 strings (not `Date`) and audit-log IDs as strings
 * (not `bigint`). Tomorrow, if any field is ever promoted to a richer
 * runtime type (e.g. `Date`), the mismatch will surface here as a type
 * error before anything else, forcing a deliberate update of the codec.
 *
 * Every wire type is `Readonly<{...}>` to signal pure-data semantics: the
 * values are plain JSON objects, never class instances, never mutated by
 * the codec layer.
 *
 * Conventions encoded here:
 *   - Branded IDs in the domain (`UserId`, `StudioId`, …) become plain
 *     `string` on the wire. Brands are a compile-time concept and never
 *     escape the TypeScript process.
 *   - `null` is used for domain fields that are always present but may be
 *     empty (e.g. `deletedAt`). Truly optional fields (the few `Set`
 *     fields) use `?` instead.
 *   - Timestamps are ISO-8601 strings with a UTC offset
 *     (`2026-01-15T09:30:00.000Z` or `±HH:MM`).
 *   - The `AuditLog.id` is a string big enough to carry a DB `BIGSERIAL`
 *     without precision loss.
 *
 * Related requirements: 21.1 (serialiser per model), 21.2 (deserialiser
 * per model), 21.3 (round-trip equivalence).
 */

export type ConsentsWire = Readonly<{
    marketing: boolean;
    analytics: boolean;
    thirdParty: boolean;
    version: string;
    updatedAt: string;
}>;

export type StudioWire = Readonly<{
    id: string;
    slug: string;
    name: string;
    brandColor: string;
    createdAt: string;
    deletedAt: string | null;
}>;

export type UserWire = Readonly<{
    id: string;
    studioId: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    role: 'member' | 'coach' | 'admin';
    consents: ConsentsWire;
    createdAt: string;
    deletedAt: string | null;
}>;

export type ClassWire = Readonly<{
    id: string;
    studioId: string;
    coachId: string | null;
    title: string;
    startsAt: string;
    durationMin: number;
    capacity: number;
    version: number;
    createdAt: string;
}>;

export type ReservationWire = Readonly<{
    id: string;
    classId: string;
    userId: string;
    status: 'confirmed' | 'waitlist' | 'cancelled' | 'no_show';
    createdAt: string;
    cancelledAt: string | null;
    checkedInAt: string | null;
}>;

export type SetWire = Readonly<{
    reps: number;
    weightKg?: number | undefined;
    durationSec?: number | undefined;
}>;

export type ExerciseWire = Readonly<{
    name: string;
    sets: ReadonlyArray<SetWire>;
}>;

export type WorkoutSessionWire = Readonly<{
    id: string;
    userId: string;
    studioId: string | null;
    startedAt: string;
    durationMin: number | null;
    exercises: ReadonlyArray<ExerciseWire>;
    notes: string | null;
    createdAt: string;
}>;

export type AuditLogWire = Readonly<{
    id: string;
    actorId: string | null;
    action: string;
    targetType: string | null;
    targetId: string | null;
    metadata: Readonly<Record<string, unknown>>;
    createdAt: string;
}>;
