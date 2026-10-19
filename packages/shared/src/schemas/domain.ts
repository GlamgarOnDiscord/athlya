/**
 * Zod schemas for every domain model exposed by the Athlya API.
 *
 * Each schema is the single source of truth for:
 *   - runtime validation of payloads crossing the wire (Requirement 14.2),
 *   - the inferred TypeScript type used by every service and client,
 *   - the round-trip contract with the serializer layer (Requirement 21.1–3).
 *
 * Fields mirror the data-model section of `design.md` (Studio, User, Class,
 * Reservation, WorkoutSession, AuditLog). Validation rules listed next to
 * each model in the design doc are encoded here.
 *
 * Related requirements: 3.1, 6.1–6.7, 7.1–7.3, 8.1–8.6, 10.1–10.5,
 * 12.1–12.4, 21.1, 21.2, 22.1.
 */

import { z } from 'zod';

import { ConsentsSchema } from './consents.js';
import {
  ClassIdSchema,
  IsoDateTimeSchema,
  ReservationIdSchema,
  ReservationStatusSchema,
  RoleSchema,
  SlugSchema,
  StudioIdSchema,
  UserIdSchema,
  UuidSchema,
} from './primitives.js';

/* ------------------------------------------------------------------ */
/*  Model 1: Studio — tenant root                                      */
/* ------------------------------------------------------------------ */

/**
 * Studio (tenant). Every other row in the system is scoped to exactly one
 * studio via its foreign key. Soft-deleted studios have `deletedAt != null`
 * and are excluded from every default query by the repository layer.
 *
 * Requirement 6.1 (studio binding), Requirement 13.2–13.3 (isolation).
 */
export const StudioSchema = z
  .object({
    id: StudioIdSchema,
    slug: SlugSchema,
    name: z.string().trim().min(1).max(120),
    brandColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'must be a #RRGGBB hex color'),
    createdAt: IsoDateTimeSchema,
    deletedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

export type Studio = z.infer<typeof StudioSchema>;

/* ------------------------------------------------------------------ */
/*  Model 2: User                                                      */
/* ------------------------------------------------------------------ */

/**
 * User. Represents both members, coaches and admins — discriminated by the
 * `role` field. Emails are stored lowercase (PostgreSQL `citext`); the
 * domain schema assumes the caller has already normalised the value. The
 * input-side lowercasing lives on the Register / Login request schemas.
 *
 * Requirement 3.1 (profile fields), Requirement 3.4 (displayName bounds).
 */
export const UserSchema = z
  .object({
    id: UserIdSchema,
    studioId: StudioIdSchema,
    email: z.email().max(254),
    displayName: z.string().trim().min(1).max(80),
    avatarUrl: z.url().nullable(),
    role: RoleSchema,
    consents: ConsentsSchema,
    createdAt: IsoDateTimeSchema,
    deletedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

export type User = z.infer<typeof UserSchema>;

/* ------------------------------------------------------------------ */
/*  Model 3: Class                                                     */
/* ------------------------------------------------------------------ */

/**
 * Class (planned session in a studio's calendar). `version` is the
 * optimistic-lock counter incremented on every successful UPDATE — any
 * client that wants to mutate a class must echo the current version back
 * or receive HTTP 409 (Requirement 6.6, 6.7).
 *
 * Requirement 6.1–6.4 (creation rules), Requirement 7.1–7.3 (browsing).
 */
export const ClassSchema = z
  .object({
    id: ClassIdSchema,
    studioId: StudioIdSchema,
    coachId: UserIdSchema.nullable(),
    title: z.string().trim().min(1).max(200),
    startsAt: IsoDateTimeSchema,
    durationMin: z.number().int().min(5).max(480),
    capacity: z.number().int().min(1).max(500),
    version: z.number().int().nonnegative(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export type Class = z.infer<typeof ClassSchema>;

/* ------------------------------------------------------------------ */
/*  Model 4: Reservation                                               */
/* ------------------------------------------------------------------ */

/**
 * Reservation. The `UNIQUE(class_id, user_id)` SQL constraint is the
 * authoritative anti-double-booking guard; this schema only validates the
 * wire shape.
 *
 * Requirement 8.1–8.6 (booking), 9.1–9.5 (cancellation),
 * 10.1–10.5 (state machine), 11.6 (`checkedInAt` set on successful scan).
 */
export const ReservationSchema = z
  .object({
    id: ReservationIdSchema,
    classId: ClassIdSchema,
    userId: UserIdSchema,
    status: ReservationStatusSchema,
    createdAt: IsoDateTimeSchema,
    cancelledAt: IsoDateTimeSchema.nullable(),
    checkedInAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

export type Reservation = z.infer<typeof ReservationSchema>;

/* ------------------------------------------------------------------ */
/*  Model 5: WorkoutSession                                            */
/* ------------------------------------------------------------------ */

/**
 * A single set inside an {@link ExerciseSchema}. `reps` is capped to
 * protect the UI layer; `weightKg` and `durationSec` are optional to cover
 * both resistance (weight × reps) and cardio / mobility (time × reps)
 * modalities.
 *
 * Requirement 12.3 (30 sets per exercise maximum enforced at the parent).
 */
export const SetSchema = z
  .object({
    reps: z.number().int().nonnegative().max(1000),
    weightKg: z.number().nonnegative().max(1000).optional(),
    durationSec: z.number().int().nonnegative().max(86_400).optional(),
  })
  .strict();

export type Set = z.infer<typeof SetSchema>;

/**
 * One exercise inside a {@link WorkoutSessionSchema}. `sets` is bounded at
 * 30 items per Requirement 12.3.
 */
export const ExerciseSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    sets: z.array(SetSchema).max(30),
  })
  .strict();

export type Exercise = z.infer<typeof ExerciseSchema>;

/** Cardio machine families a session can be recorded on (FTMS, Epic 23). */
export const CARDIO_MACHINES = ['indoorBike', 'treadmill', 'rower', 'crossTrainer'] as const;

export type CardioMachine = (typeof CARDIO_MACHINES)[number];

/**
 * Structured cardio summary of a session recorded on a machine (issue
 * #667). Every metric is optional: a machine reports only some of them.
 * `durationSec` is the moving time, more precise than the session's
 * rounded `durationMin`. Bounds are generous physical ceilings that
 * reject corrupted sensor values.
 */
export const CardioMetricsSchema = z
  .object({
    machine: z.enum(CARDIO_MACHINES).optional(),
    durationSec: z.number().int().nonnegative().max(86_400).optional(),
    distanceM: z.number().int().nonnegative().max(1_000_000).optional(),
    energyKcal: z.number().int().nonnegative().max(20_000).optional(),
    avgPowerW: z.number().int().nonnegative().max(4_000).optional(),
    maxPowerW: z.number().int().nonnegative().max(4_000).optional(),
    avgCadenceRpm: z.number().int().nonnegative().max(300).optional(),
    avgSpeedKmh: z.number().nonnegative().max(150).optional(),
    avgHeartRateBpm: z.number().int().min(20).max(250).optional(),
    maxHeartRateBpm: z.number().int().min(20).max(250).optional(),
    strokeCount: z.number().int().nonnegative().max(100_000).optional(),
  })
  .strict();

export type CardioMetrics = z.infer<typeof CardioMetricsSchema>;

/**
 * Workout session. `studioId` is nullable so members can log activity done
 * outside a partner studio (home gym, outdoor run). `cardio` is present
 * only on sessions logged with a structured cardio summary.
 *
 * Requirement 12.1 (persistence), 12.2 (≤ 50 exercises), 12.4 (history).
 */
export const WorkoutSessionSchema = z
  .object({
    id: UuidSchema.transform(
      (v): string & { readonly __brand: 'WorkoutSessionId' } =>
        v as string & { readonly __brand: 'WorkoutSessionId' },
    ),
    userId: UserIdSchema,
    studioId: StudioIdSchema.nullable(),
    startedAt: IsoDateTimeSchema,
    durationMin: z.number().int().positive().nullable(),
    exercises: z.array(ExerciseSchema).max(50),
    notes: z.string().max(2000).nullable(),
    cardio: CardioMetricsSchema.optional(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export type WorkoutSession = z.infer<typeof WorkoutSessionSchema>;

/* ------------------------------------------------------------------ */
/*  Model 6: AuditLog                                                  */
/* ------------------------------------------------------------------ */

/**
 * Immutable audit record. The DB primary key is BIGSERIAL; we serialize it
 * as a string to stay safe above `Number.MAX_SAFE_INTEGER` (Requirement
 * 21.1 — lossless JSON round-trip for bigints).
 *
 * `metadata` is intentionally open (not `.strict()`) because it carries
 * arbitrary context from the caller (changed fields, IP, user agent, …)
 * and the shape legitimately varies per `action`.
 *
 * Requirement 22.1 (append-only storage; RLS enforces immutability).
 * Requirement 5.3 (30-day anonymisation of `actorId` + `metadata` after
 * the referenced user is deleted — hence the nullable `actorId`).
 */
export const AuditLogSchema = z
  .object({
    id: z.string().min(1),
    actorId: UserIdSchema.nullable(),
    action: z.string().min(1).max(120),
    targetType: z.string().max(60).nullable(),
    targetId: z.string().max(80).nullable(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export type AuditLog = z.infer<typeof AuditLogSchema>;
