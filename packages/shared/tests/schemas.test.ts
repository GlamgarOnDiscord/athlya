/**
 * Unit tests for the Zod schemas exported by `@athlya/shared/schemas`.
 *
 * Every schema in `src/schemas/**` is the single source of truth for the
 * validation performed by the API Gateway (Requirement 14.2). These tests
 * focus on *rejections*: invalid payloads must surface a precise `path`
 * pointing at the offending field, because that path is what the gateway
 * echoes back in the `errors[]` entry of the RFC 7807 Problem Details
 * response. Happy-path round-trip behaviour lives in
 * `tests/properties/round-trip.property.test.ts` (task 1.5).
 *
 * Related requirements: 14.2, 3.3, 3.4, 6.1–6.4, 8.1–8.2, 10.1,
 * 12.2–12.3, 7.3, 5.3, 21.1.
 */

import { describe, expect, it } from 'vitest';

import {
  BookingResponseSchema,
  CreateClassRequestSchema,
  ListClassesQuerySchema,
  LogSessionRequestSchema,
  RegisterRequestSchema,
} from '../src/schemas/api.js';
import { ConsentsSchema } from '../src/schemas/consents.js';
import {
  AuditLogSchema,
  CardioMetricsSchema,
  ClassSchema,
  ReservationSchema,
  StudioSchema,
  UserSchema,
  WorkoutSessionSchema,
} from '../src/schemas/domain.js';
import { ProblemDetailsSchema } from '../src/schemas/problem.js';

import type { z } from 'zod';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

/** Canonical RFC-4122 UUID v4 values reused as stand-ins for branded IDs. */
const UUID_A = 'a1b2c3d4-5678-4abc-89ef-1234567890ab';
const UUID_B = 'b2c3d4e5-6789-4bcd-9aef-234567890abc';
const UUID_C = 'c3d4e5f6-789a-4cde-abef-34567890abcd';
const UUID_D = 'd4e5f6a7-89ab-4def-bcef-4567890abcde';

/** Valid, UTC ISO-8601 timestamps as emitted by `Date#toISOString()`. */
const NOW = '2025-01-15T10:00:00.000Z';
const LATER = '2025-01-15T11:00:00.000Z';

/**
 * Run `schema.safeParse(input)`, assert it failed and return the (typed)
 * array of issues so individual assertions stay terse and readable.
 */
function expectFailure<S extends z.ZodType>(
  schema: S,
  input: unknown,
): ReadonlyArray<z.core.$ZodIssue> {
  const result = schema.safeParse(input);
  expect(result.success).toBe(false);
  if (result.success) {
    // The `expect(...).toBe(false)` above already failed the test; this
    // throw makes the return type non-nullable for the callers.
    throw new Error('safeParse unexpectedly succeeded');
  }
  return result.error.issues;
}

/**
 * Assert at least one issue in `issues` targets the given dotted path.
 * We compare stringified paths so numeric array indices read naturally
 * next to object keys (e.g. `"exercises.0.sets"`).
 */
function expectPath(
  issues: ReadonlyArray<z.core.$ZodIssue>,
  path: ReadonlyArray<string | number>,
): void {
  const normalised = issues.map((i) => i.path.map(String).join('.'));
  expect(normalised).toContain(path.map(String).join('.'));
}

/* ================================================================== */
/*  ConsentsSchema                                                     */
/* ================================================================== */

describe('ConsentsSchema', () => {
  const valid = {
    marketing: true,
    analytics: false,
    thirdParty: false,
    version: '2025-01',
    updatedAt: NOW,
  };

  it('accepts a well-formed consents record', () => {
    expect(ConsentsSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a missing marketing flag with path=["marketing"]', () => {
    const { marketing: _marketing, ...partial } = valid;
    const issues = expectFailure(ConsentsSchema, partial);
    expectPath(issues, ['marketing']);
  });

  it('rejects a wrong-typed marketing flag (string) with path=["marketing"]', () => {
    const issues = expectFailure(ConsentsSchema, { ...valid, marketing: 'yes' });
    expectPath(issues, ['marketing']);
  });

  it.each([['2026'], ['2026-1'], ['not-a-version']])(
    'rejects an invalid version %p with path=["version"]',
    (bogusVersion) => {
      const issues = expectFailure(ConsentsSchema, { ...valid, version: bogusVersion });
      expectPath(issues, ['version']);
    },
  );

  it('rejects a non-ISO updatedAt with path=["updatedAt"]', () => {
    const issues = expectFailure(ConsentsSchema, { ...valid, updatedAt: 'yesterday' });
    expectPath(issues, ['updatedAt']);
  });

  it('rejects an unknown field in strict mode with code="unrecognized_keys"', () => {
    const issues = expectFailure(ConsentsSchema, { ...valid, extraField: 'nope' });
    expect(issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
  });
});

/* ================================================================== */
/*  StudioSchema                                                       */
/* ================================================================== */

describe('StudioSchema', () => {
  const valid = {
    id: UUID_A,
    slug: 'athlya-paris',
    name: 'Athlya Paris',
    brandColor: '#0066FF',
    createdAt: NOW,
    deletedAt: null,
  };

  it('accepts a well-formed studio payload', () => {
    expect(StudioSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a non-UUID id with path=["id"]', () => {
    const issues = expectFailure(StudioSchema, { ...valid, id: 'not-a-uuid' });
    expectPath(issues, ['id']);
  });

  it('rejects a slug containing uppercase letters with path=["slug"]', () => {
    const issues = expectFailure(StudioSchema, { ...valid, slug: 'Athlya-Paris' });
    expectPath(issues, ['slug']);
  });

  it('rejects a name longer than 120 chars with path=["name"]', () => {
    const issues = expectFailure(StudioSchema, { ...valid, name: 'a'.repeat(121) });
    expectPath(issues, ['name']);
  });

  it.each([['#ABC'], ['red']])(
    'rejects a brandColor %p that is not #RRGGBB with path=["brandColor"]',
    (bogus) => {
      const issues = expectFailure(StudioSchema, { ...valid, brandColor: bogus });
      expectPath(issues, ['brandColor']);
    },
  );
});

/* ================================================================== */
/*  UserSchema                                                         */
/* ================================================================== */

describe('UserSchema', () => {
  const validConsents = {
    marketing: false,
    analytics: false,
    thirdParty: false,
    version: '2025-01',
    updatedAt: NOW,
  };

  const valid = {
    id: UUID_A,
    studioId: UUID_B,
    email: 'member@example.com',
    displayName: 'Alice',
    avatarUrl: null,
    role: 'member' as const,
    consents: validConsents,
    createdAt: NOW,
    deletedAt: null,
  };

  it('accepts a well-formed user payload', () => {
    expect(UserSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an invalid email with path=["email"]', () => {
    const issues = expectFailure(UserSchema, { ...valid, email: 'not-an-email' });
    expectPath(issues, ['email']);
  });

  it('rejects displayName length 0 (after trim) with path=["displayName"] (Req 3.4)', () => {
    const issues = expectFailure(UserSchema, { ...valid, displayName: '   ' });
    expectPath(issues, ['displayName']);
  });

  it('rejects displayName longer than 80 chars with path=["displayName"] (Req 3.4)', () => {
    const issues = expectFailure(UserSchema, { ...valid, displayName: 'a'.repeat(81) });
    expectPath(issues, ['displayName']);
  });

  it('rejects a role outside the enum with path=["role"]', () => {
    const issues = expectFailure(UserSchema, { ...valid, role: 'superuser' });
    expectPath(issues, ['role']);
  });

  it('rejects malformed consents.version with path=["consents","version"] (Req 3.3)', () => {
    const issues = expectFailure(UserSchema, {
      ...valid,
      consents: { ...validConsents, version: '2025/01' },
    });
    expectPath(issues, ['consents', 'version']);
  });
});

/* ================================================================== */
/*  ClassSchema                                                        */
/* ================================================================== */

describe('ClassSchema', () => {
  const valid = {
    id: UUID_A,
    studioId: UUID_B,
    coachId: UUID_C,
    title: 'Morning HIIT',
    startsAt: NOW,
    durationMin: 45,
    capacity: 20,
    version: 0,
    createdAt: NOW,
  };

  it('accepts a well-formed class payload', () => {
    expect(ClassSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects capacity = 0 (below min) with path=["capacity"]', () => {
    const issues = expectFailure(ClassSchema, { ...valid, capacity: 0 });
    expectPath(issues, ['capacity']);
  });

  it('rejects capacity = 501 (above max) with path=["capacity"]', () => {
    const issues = expectFailure(ClassSchema, { ...valid, capacity: 501 });
    expectPath(issues, ['capacity']);
  });

  it('rejects durationMin = 4 (below min) with path=["durationMin"]', () => {
    const issues = expectFailure(ClassSchema, { ...valid, durationMin: 4 });
    expectPath(issues, ['durationMin']);
  });

  it('rejects durationMin = 481 (above max) with path=["durationMin"]', () => {
    const issues = expectFailure(ClassSchema, { ...valid, durationMin: 481 });
    expectPath(issues, ['durationMin']);
  });

  it('rejects a negative version with path=["version"]', () => {
    const issues = expectFailure(ClassSchema, { ...valid, version: -1 });
    expectPath(issues, ['version']);
  });
});

/* ================================================================== */
/*  ReservationSchema                                                  */
/* ================================================================== */

describe('ReservationSchema', () => {
  const valid = {
    id: UUID_A,
    classId: UUID_B,
    userId: UUID_C,
    status: 'confirmed' as const,
    createdAt: NOW,
    cancelledAt: null,
    checkedInAt: null,
  };

  it('accepts a well-formed reservation payload', () => {
    expect(ReservationSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a status outside the enum with path=["status"]', () => {
    const issues = expectFailure(ReservationSchema, { ...valid, status: 'pending' });
    expectPath(issues, ['status']);
  });

  it('rejects a non-ISO cancelledAt (non-null string) with path=["cancelledAt"]', () => {
    const issues = expectFailure(ReservationSchema, {
      ...valid,
      cancelledAt: 'not-a-timestamp',
    });
    expectPath(issues, ['cancelledAt']);
  });
});

/* ================================================================== */
/*  WorkoutSessionSchema                                               */
/* ================================================================== */

describe('WorkoutSessionSchema', () => {
  const validSet = { reps: 10, weightKg: 60 };
  const validExercise = { name: 'Back Squat', sets: [validSet, validSet] };
  const valid = {
    id: UUID_A,
    userId: UUID_B,
    studioId: UUID_C,
    startedAt: NOW,
    durationMin: 60,
    exercises: [validExercise],
    notes: 'Felt strong.',
    createdAt: NOW,
  };

  it('accepts a well-formed workout session payload', () => {
    expect(WorkoutSessionSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects > 50 exercises with path=["exercises"] and code="too_big" (Req 12.2)', () => {
    const session = {
      ...valid,
      exercises: Array.from({ length: 51 }, () => validExercise),
    };
    const issues = expectFailure(WorkoutSessionSchema, session);
    expectPath(issues, ['exercises']);
    expect(issues.some((i) => i.code === 'too_big')).toBe(true);
  });

  it('rejects an exercise with > 30 sets with path=["exercises",0,"sets"] (Req 12.3)', () => {
    const session = {
      ...valid,
      exercises: [
        {
          name: 'Bench Press',
          sets: Array.from({ length: 31 }, () => validSet),
        },
      ],
    };
    const issues = expectFailure(WorkoutSessionSchema, session);
    expectPath(issues, ['exercises', 0, 'sets']);
  });

  it('rejects a negative reps value with path=["exercises",0,"sets",0,"reps"]', () => {
    const session = {
      ...valid,
      exercises: [{ name: 'Deadlift', sets: [{ reps: -1 }] }],
    };
    const issues = expectFailure(WorkoutSessionSchema, session);
    expectPath(issues, ['exercises', 0, 'sets', 0, 'reps']);
  });

  it('rejects notes longer than 2000 chars with path=["notes"]', () => {
    const session = { ...valid, notes: 'x'.repeat(2001) };
    const issues = expectFailure(WorkoutSessionSchema, session);
    expectPath(issues, ['notes']);
  });

  it('accepts a session with a structured cardio summary (issue #667)', () => {
    const session = {
      ...valid,
      cardio: { machine: 'rower', durationSec: 1_200, distanceM: 5_000, avgPowerW: 180 },
    };
    expect(WorkoutSessionSchema.safeParse(session).success).toBe(true);
  });

  it('rejects an explicit null cardio: the key is omitted when absent', () => {
    const issues = expectFailure(WorkoutSessionSchema, { ...valid, cardio: null });
    expectPath(issues, ['cardio']);
  });
});

describe('CardioMetricsSchema', () => {
  it('accepts an empty summary and every metric on its own', () => {
    expect(CardioMetricsSchema.safeParse({}).success).toBe(true);
    expect(CardioMetricsSchema.safeParse({ avgSpeedKmh: 12.5 }).success).toBe(true);
    expect(CardioMetricsSchema.safeParse({ strokeCount: 900 }).success).toBe(true);
  });

  it('rejects an unknown machine with path=["machine"]', () => {
    expectPath(expectFailure(CardioMetricsSchema, { machine: 'stairs' }), ['machine']);
  });

  it('rejects unknown keys (strict)', () => {
    expect(CardioMetricsSchema.safeParse({ watts: 100 }).success).toBe(false);
  });

  it.each([
    ['durationSec', 86_401],
    ['distanceM', 1_000_001],
    ['distanceM', 12.5],
    ['energyKcal', -1],
    ['avgPowerW', 4_001],
    ['maxPowerW', 4_001],
    ['avgCadenceRpm', 301],
    ['avgSpeedKmh', 150.1],
    ['avgHeartRateBpm', 19],
    ['maxHeartRateBpm', 251],
    ['strokeCount', 100_001],
  ] as const)('rejects %s = %s', (key, value) => {
    expectPath(expectFailure(CardioMetricsSchema, { [key]: value }), [key]);
  });
});

/* ================================================================== */
/*  AuditLogSchema                                                     */
/* ================================================================== */

describe('AuditLogSchema', () => {
  const valid = {
    id: '42',
    actorId: UUID_A,
    action: 'reservation.created',
    targetType: 'reservation',
    targetId: UUID_B,
    metadata: { classId: UUID_C },
    createdAt: NOW,
  };

  it('accepts a well-formed audit log record', () => {
    expect(AuditLogSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a null actorId (post-anonymisation per Req 5.3)', () => {
    expect(AuditLogSchema.safeParse({ ...valid, actorId: null }).success).toBe(true);
  });

  it('rejects an empty id with path=["id"] (Req 21.1 — bigint serialised as non-empty string)', () => {
    const issues = expectFailure(AuditLogSchema, { ...valid, id: '' });
    expectPath(issues, ['id']);
  });

  it('rejects an action longer than 120 chars with path=["action"]', () => {
    const issues = expectFailure(AuditLogSchema, { ...valid, action: 'a'.repeat(121) });
    expectPath(issues, ['action']);
  });
});

/* ================================================================== */
/*  RegisterRequestSchema                                              */
/* ================================================================== */

describe('RegisterRequestSchema', () => {
  const valid = {
    email: 'user@example.com',
    password: 'correct horse battery staple',
    displayName: 'Alice',
    studioSlug: 'athlya-paris',
    consents: { marketing: false, analytics: false, thirdParty: false },
  };

  it('accepts a well-formed registration payload', () => {
    expect(RegisterRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a password shorter than 8 chars with path=["password"]', () => {
    const issues = expectFailure(RegisterRequestSchema, { ...valid, password: 'short' });
    expectPath(issues, ['password']);
  });

  it('lowercases the email via its transform (Req 14.2)', () => {
    // The transform runs after validation: a mixed-case input succeeds
    // and the parsed output carries the normalised lowercase email.
    const parsed = RegisterRequestSchema.parse({ ...valid, email: 'MiXeD@Example.COM' });
    expect(parsed.email).toBe('mixed@example.com');
  });

  it('rejects a password longer than 72 bytes (bcrypt input limit)', () => {
    // bcrypt silently truncates input at 72 bytes: accepting a longer
    // password hashes only the first 72 chars. Cap the schema so the
    // truncation never happens (OWASP Password Storage Cheatsheet).
    const issues = expectFailure(RegisterRequestSchema, {
      ...valid,
      password: 'a'.repeat(73),
    });
    expectPath(issues, ['password']);
  });

  it('accepts a password exactly 72 bytes long (bcrypt boundary)', () => {
    expect(
      RegisterRequestSchema.safeParse({
        ...valid,
        password: 'a'.repeat(72),
      }).success,
    ).toBe(true);
  });
});

/* ================================================================== */
/*  CreateClassRequestSchema — selected API-layer bounds               */
/* ================================================================== */

describe('CreateClassRequestSchema', () => {
  const valid = {
    title: 'Yoga Flow',
    startsAt: NOW,
    durationMin: 60,
    capacity: 15,
    coachId: UUID_D,
  };

  it('accepts a well-formed create-class payload', () => {
    expect(CreateClassRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects capacity = 501 at the API boundary with path=["capacity"]', () => {
    const issues = expectFailure(CreateClassRequestSchema, { ...valid, capacity: 501 });
    expectPath(issues, ['capacity']);
  });

  it('rejects durationMin = 4 at the API boundary with path=["durationMin"]', () => {
    const issues = expectFailure(CreateClassRequestSchema, { ...valid, durationMin: 4 });
    expectPath(issues, ['durationMin']);
  });
});

/* ================================================================== */
/*  BookingResponseSchema — discriminated union                        */
/* ================================================================== */

describe('BookingResponseSchema', () => {
  const reservation = {
    id: UUID_A,
    classId: UUID_B,
    userId: UUID_C,
    status: 'confirmed' as const,
    createdAt: NOW,
    cancelledAt: null,
    checkedInAt: null,
  };

  it('accepts the confirmed arm', () => {
    expect(BookingResponseSchema.safeParse({ status: 'confirmed', reservation }).success).toBe(
      true,
    );
  });

  it('accepts the waitlist arm with a position', () => {
    expect(
      BookingResponseSchema.safeParse({
        status: 'waitlist',
        reservation: { ...reservation, status: 'waitlist' },
        position: 3,
      }).success,
    ).toBe(true);
  });

  it('rejects the waitlist arm missing a position with path=["position"] (Req 8.2)', () => {
    const issues = expectFailure(BookingResponseSchema, {
      status: 'waitlist',
      reservation: { ...reservation, status: 'waitlist' },
    });
    expectPath(issues, ['position']);
  });

  it('rejects the confirmed arm carrying an unknown "position" field', () => {
    const issues = expectFailure(BookingResponseSchema, {
      status: 'confirmed',
      reservation,
      position: 1,
    });
    expect(issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
  });
});

/* ================================================================== */
/*  ListClassesQuerySchema — range refinement                          */
/* ================================================================== */

describe('ListClassesQuerySchema', () => {
  it('accepts a valid (from, to) range', () => {
    expect(ListClassesQuerySchema.safeParse({ from: NOW, to: LATER }).success).toBe(true);
  });

  it('rejects an inverted range with a "after from"-style message', () => {
    const issues = expectFailure(ListClassesQuerySchema, { from: LATER, to: NOW });
    // The refine attaches `path: ['to']`, but also accept either
    // signal per the task wording.
    expect(
      issues.some((i) => i.path.map(String).join('.') === 'to' || /after from/i.test(i.message)),
    ).toBe(true);
  });

  it('rejects a range > 90 days with a "90 days"-style message (Req 7.3)', () => {
    const issues = expectFailure(ListClassesQuerySchema, {
      from: '2025-01-01T00:00:00.000Z',
      to: '2025-05-01T00:00:00.000Z',
    });
    expect(
      issues.some((i) => i.path.map(String).join('.') === 'to' || /90 days/i.test(i.message)),
    ).toBe(true);
  });
});

/* ================================================================== */
/*  LogSessionRequestSchema — API-layer bounds                         */
/* ================================================================== */

describe('LogSessionRequestSchema', () => {
  it('accepts an optional cardio summary and stays valid without one', () => {
    const base = { startedAt: NOW, exercises: [{ name: 'Rower', sets: [{ reps: 0 }] }] };
    expect(LogSessionRequestSchema.safeParse(base).success).toBe(true);
    expect(
      LogSessionRequestSchema.safeParse({ ...base, cardio: { machine: 'rower', distanceM: 2_000 } })
        .success,
    ).toBe(true);
  });

  it('rejects an out-of-bounds cardio metric with path=["cardio","avgPowerW"]', () => {
    const issues = expectFailure(LogSessionRequestSchema, {
      startedAt: NOW,
      exercises: [],
      cardio: { avgPowerW: 10_000 },
    });
    expectPath(issues, ['cardio', 'avgPowerW']);
  });

  it('rejects > 50 exercises at the API boundary (Req 12.2)', () => {
    const payload = {
      startedAt: NOW,
      exercises: Array.from({ length: 51 }, () => ({
        name: 'Push-ups',
        sets: [{ reps: 10 }],
      })),
    };
    const issues = expectFailure(LogSessionRequestSchema, payload);
    expectPath(issues, ['exercises']);
  });
});

/* ================================================================== */
/*  ProblemDetailsSchema                                               */
/* ================================================================== */

describe('ProblemDetailsSchema', () => {
  it('accepts a minimal payload and defaults type to "about:blank"', () => {
    const parsed = ProblemDetailsSchema.parse({ title: 'Not Found', status: 404 });
    expect(parsed.type).toBe('about:blank');
    expect(parsed.status).toBe(404);
    expect(parsed.title).toBe('Not Found');
  });

  it('rejects status < 100 with path=["status"]', () => {
    const issues = expectFailure(ProblemDetailsSchema, { title: 'Bad', status: 99 });
    expectPath(issues, ['status']);
  });

  it('rejects status > 599 with path=["status"]', () => {
    const issues = expectFailure(ProblemDetailsSchema, { title: 'Bad', status: 600 });
    expectPath(issues, ['status']);
  });
});
