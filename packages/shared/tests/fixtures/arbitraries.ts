/**
 * fast-check arbitraries for every Athlya domain model.
 *
 * These generators are the source of truth used by the property tests in
 * `tests/properties/*.property.test.ts`. Each one is crafted to match the
 * exact contract of the corresponding Zod schema in
 * `src/schemas/*.ts` — produce only values the schema accepts, nothing more,
 * nothing less.
 *
 * Design notes:
 *   - Every generator avoids whitespace-only edges so values survive Zod's
 *     `.trim()` transforms byte-for-byte (any whitespace at the boundary
 *     would be stripped on deserialisation and break the round-trip).
 *   - Timestamps go through a deterministic `new Date(ms).toISOString()`
 *     pipeline to guarantee ISO-8601 output with the `Z` offset, matching
 *     `IsoDateTimeSchema` / `{ offset: true }`.
 *   - `Set` and `WorkoutSession` generators preserve the *presence vs
 *     absence* distinction for optional fields (critical because the
 *     workspace compiles under `exactOptionalPropertyTypes: true` and the
 *     codec layer specifically documents this guarantee).
 *   - `AuditLog.metadata` is built from `fc.jsonValue()` so the round-trip
 *     never encounters `undefined`, functions or class instances — values
 *     outside the JSON spec are neither required nor welcome on the wire.
 *
 * Related requirements: 21.1, 21.2, 21.3 (round-trip consistency).
 */

import { fc } from '@fast-check/vitest';

import type { ClassId, ReservationId, StudioId, UserId } from '../../src/ids.js';
import type { Consents } from '../../src/schemas/consents.js';
import type {
  AuditLog,
  Class,
  Exercise,
  Reservation,
  Set,
  Studio,
  User,
  WorkoutSession,
} from '../../src/schemas/domain.js';

/* ------------------------------------------------------------------ */
/*  Primitive building blocks                                          */
/* ------------------------------------------------------------------ */

/**
 * UUID matching the `UUID_REGEX` shared by `@athlya/shared/ids`.
 * fast-check's default `fc.uuid()` produces v1–v5 RFC 4122 UUIDs, which
 * fit the regex `[1-8]` version byte and `[89ab]` variant byte.
 */
export const uuidArb = fc.uuid();

/**
 * Branded UUID arbitraries. The `__brand` tag is a compile-time-only
 * phantom symbol — at runtime, a `UserId` is simply a string — so the
 * cast below is safe and lets generated values flow straight into
 * domain types without a second cast at every call site.
 *
 * Producing distinct arbitraries per brand (rather than reusing
 * `uuidArb` everywhere) keeps the property tests type-clean under
 * `exactOptionalPropertyTypes: true` and surfaces any accidental swap
 * of ID kinds at the arbitrary level.
 */
export const userIdArb = uuidArb as fc.Arbitrary<UserId>;
export const studioIdArb = uuidArb as fc.Arbitrary<StudioId>;
export const classIdArb = uuidArb as fc.Arbitrary<ClassId>;
export const reservationIdArb = uuidArb as fc.Arbitrary<ReservationId>;
/**
 * `WorkoutSessionSchema` uses an inline-branded UUID (see
 * `src/schemas/domain.ts`) rather than a named brand in `ids.ts`, so
 * we mirror that shape here.
 */
export const workoutSessionIdArb = uuidArb as fc.Arbitrary<
  string & { readonly __brand: 'WorkoutSessionId' }
>;

/**
 * ISO-8601 datetime with a UTC offset (the literal `Z` suffix produced
 * by `Date#toISOString()`). We drive the generator from integer
 * milliseconds inside `[1970-01-01, 2100-12-31]` so it is deterministic
 * across fast-check versions and never produces "Invalid Date".
 */
const EPOCH_MIN_MS = Date.UTC(1970, 0, 1, 0, 0, 0, 0);
const EPOCH_MAX_MS = Date.UTC(2100, 11, 31, 23, 59, 59, 999);

export const isoDateTimeArb = fc
  .integer({ min: EPOCH_MIN_MS, max: EPOCH_MAX_MS })
  .map((ms) => new Date(ms).toISOString());

/**
 * URL-safe studio slug — `/^[a-z0-9-]{3,50}$/`. Matches `SlugSchema`
 * verbatim; no filtering needed.
 */
const SLUG_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-'.split('');

export const slugArb = fc.stringOf(fc.constantFrom(...SLUG_CHARS), {
  minLength: 3,
  maxLength: 50,
});

/**
 * `#RRGGBB` hex color. We emit lowercase digits because the domain
 * schema accepts both cases (`/^#[0-9A-Fa-f]{6}$/`); uppercase output is
 * not needed for round-trip coverage.
 */
const HEX_CHARS = '0123456789abcdef'.split('');

export const hexColorArb = fc
  .stringOf(fc.constantFrom(...HEX_CHARS), { minLength: 6, maxLength: 6 })
  .map((s) => `#${s}`);

/**
 * Email address. Zod 4's `.email()` uses an HTML5-like regex that
 * requires the local part to end with `[A-Z0-9_+-]`, the domain label to
 * start with `[A-Z0-9]`, and the TLD to be at least two letters. We
 * construct emails that satisfy those rules *by construction* so we
 * avoid a high-rejection `.filter()` chain. Output is always lowercase
 * because `UserSchema.email` does not apply a case-normalising
 * transform — the caller (API input layer) is responsible for that and
 * our generator mimics already-normalised storage.
 */
const ALNUM_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
const TLD_CHARS = 'abcdefghijklmnopqrstuvwxyz'.split('');

export const emailArb = fc
  .tuple(
    fc.stringOf(fc.constantFrom(...ALNUM_CHARS), { minLength: 1, maxLength: 30 }),
    fc.stringOf(fc.constantFrom(...ALNUM_CHARS), { minLength: 1, maxLength: 20 }),
    fc.stringOf(fc.constantFrom(...TLD_CHARS), { minLength: 2, maxLength: 6 }),
  )
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`)
  .filter((e) => e.length <= 254);

/**
 * A string that survives Zod's `.trim().min(1).max(max)` unchanged. We
 * restrict the charset to visible ASCII minus whitespace so trim is the
 * identity and length is preserved across serialisation.
 */
const VISIBLE_NON_WS = (
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ' +
  '0123456789' +
  '!@#$%^&*()_=+[]{};:,.<>?'
).split('');

export const nonEmptyTrimmedString = (max: number): fc.Arbitrary<string> =>
  fc.stringOf(fc.constantFrom(...VISIBLE_NON_WS), { minLength: 1, maxLength: max });

/* ------------------------------------------------------------------ */
/*  Enums                                                              */
/* ------------------------------------------------------------------ */

export const roleArb: fc.Arbitrary<'member' | 'coach' | 'admin'> = fc.constantFrom(
  'member',
  'coach',
  'admin',
);

export const reservationStatusArb: fc.Arbitrary<
  'confirmed' | 'waitlist' | 'cancelled' | 'no_show'
> = fc.constantFrom('confirmed', 'waitlist', 'cancelled', 'no_show');

/**
 * Consent version identifier — `YYYY-MM`, matching the regex enforced by
 * `ConsentsVersionSchema`. Lexicographic ordering over `YYYY-MM` agrees
 * with chronological ordering, which is the runtime invariant we rely on
 * elsewhere.
 */
export const consentsVersionArb = fc
  .integer({ min: 1970, max: 2099 })
  .chain((year) =>
    fc.integer({ min: 1, max: 12 }).map((month) => `${year}-${String(month).padStart(2, '0')}`),
  );

/* ------------------------------------------------------------------ */
/*  Composite domain shapes                                             */
/* ------------------------------------------------------------------ */

export const consentsArb: fc.Arbitrary<Consents> = fc.record({
  marketing: fc.boolean(),
  analytics: fc.boolean(),
  thirdParty: fc.boolean(),
  version: consentsVersionArb,
  updatedAt: isoDateTimeArb,
});

export const studioArb: fc.Arbitrary<Studio> = fc.record({
  id: studioIdArb,
  slug: slugArb,
  name: nonEmptyTrimmedString(120),
  brandColor: hexColorArb,
  createdAt: isoDateTimeArb,
  deletedAt: fc.option(isoDateTimeArb, { nil: null }),
});

/**
 * `avatarUrl` comes out of `fc.webUrl()`, which builds URLs the
 * `new URL(...)` constructor accepts — Zod 4's `.url()` delegates to
 * that constructor, so no extra filtering is required.
 */
export const userArb: fc.Arbitrary<User> = fc.record({
  id: userIdArb,
  studioId: studioIdArb,
  email: emailArb,
  displayName: nonEmptyTrimmedString(80),
  avatarUrl: fc.option(fc.webUrl(), { nil: null }),
  role: roleArb,
  consents: consentsArb,
  createdAt: isoDateTimeArb,
  deletedAt: fc.option(isoDateTimeArb, { nil: null }),
});

export const classArb: fc.Arbitrary<Class> = fc.record({
  id: classIdArb,
  studioId: studioIdArb,
  coachId: fc.option(userIdArb, { nil: null }),
  title: nonEmptyTrimmedString(200),
  startsAt: isoDateTimeArb,
  durationMin: fc.integer({ min: 5, max: 480 }),
  capacity: fc.integer({ min: 1, max: 500 }),
  version: fc.nat(),
  createdAt: isoDateTimeArb,
});

export const reservationArb: fc.Arbitrary<Reservation> = fc.record({
  id: reservationIdArb,
  classId: classIdArb,
  userId: userIdArb,
  status: reservationStatusArb,
  createdAt: isoDateTimeArb,
  cancelledAt: fc.option(isoDateTimeArb, { nil: null }),
  checkedInAt: fc.option(isoDateTimeArb, { nil: null }),
});

/**
 * `Set` preserves presence vs absence for `weightKg` and `durationSec`
 * so a round-trip through `SetCodec` is bit-for-bit stable under
 * `exactOptionalPropertyTypes: true`. The codec explicitly documents
 * this behaviour, so the generator must mirror it.
 */
export const setArb: fc.Arbitrary<Set> = fc
  .tuple(
    fc.integer({ min: 0, max: 1000 }),
    fc.option(
      fc.double({
        min: 0,
        max: 1000,
        noNaN: true,
        noDefaultInfinity: true,
      }),
      { nil: null },
    ),
    fc.option(fc.integer({ min: 0, max: 86_400 }), { nil: null }),
  )
  .map(([reps, weight, duration]) => {
    const out: Set = { reps };
    if (weight !== null) {
      out.weightKg = weight;
    }
    if (duration !== null) {
      out.durationSec = duration;
    }
    return out;
  });

export const exerciseArb: fc.Arbitrary<Exercise> = fc.record({
  name: nonEmptyTrimmedString(120),
  sets: fc.array(setArb, { maxLength: 30 }),
});

export const workoutSessionArb: fc.Arbitrary<WorkoutSession> = fc.record({
  id: workoutSessionIdArb,
  userId: userIdArb,
  studioId: fc.option(studioIdArb, { nil: null }),
  startedAt: isoDateTimeArb,
  durationMin: fc.option(fc.integer({ min: 1, max: 86_400 }), { nil: null }),
  exercises: fc.array(exerciseArb, { maxLength: 50 }),
  notes: fc.option(fc.string({ maxLength: 2000 }), { nil: null }),
  createdAt: isoDateTimeArb,
});

/**
 * `AuditLog.id` is a `BIGSERIAL` rendered as a decimal string on the
 * wire. We generate it as a bigint in the signed 64-bit positive range
 * and stringify — that is the exact contract `bigintToId` / `idToBigint`
 * enforce.
 *
 * `metadata` uses `fc.jsonValue()` so the round-trip never sees values
 * outside the JSON spec (no `undefined`, no functions, no `NaN`). Keys
 * are non-empty strings because Zod's `z.record(z.string(), ...)` treats
 * empty keys as valid but fast-check's `fc.dictionary` is meaningfully
 * more useful with concrete labels.
 */
export const auditLogArb: fc.Arbitrary<AuditLog> = fc.record({
  id: fc.bigInt({ min: 1n, max: 2n ** 63n - 1n }).map((n) => String(n)),
  actorId: fc.option(userIdArb, { nil: null }),
  action: nonEmptyTrimmedString(120),
  targetType: fc.option(fc.string({ maxLength: 60 }), { nil: null }),
  targetId: fc.option(fc.string({ maxLength: 80 }), { nil: null }),
  metadata: fc
    .dictionary(fc.string({ minLength: 1, maxLength: 40 }), fc.jsonValue(), { maxKeys: 8 })
    .map((v) => JSON.parse(JSON.stringify(v)) as Record<string, unknown>),
  createdAt: isoDateTimeArb,
});
