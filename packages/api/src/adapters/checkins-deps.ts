/**
 * Compose the router-level {@link CheckinsDeps} bundle from a live
 * `AthlyaBindings` env — issue #654 (part of #648), Requirement 11.
 *
 *   - `issueToken` signs a `QR_Checkin_Token` for the caller with the
 *     Worker's RS256 key (`JWT_KID` / `JWT_PRIVATE_KEY_PEM` /
 *     `JWT_PUBLIC_KEY_PEM`, the auth Worker's key pair).
 *   - `checkIn` runs the `@athlya/reservations` `checkIn` use case for
 *     the kiosk operator: the token is verified against `JWKS_JSON`
 *     (both keys during a rotation) before any database read, its `jti`
 *     is consumed atomically in Redis, then the member's reservation is
 *     looked up under the operator's claims (RLS) and stamped through
 *     `checkin_mark_reservation` (migration 0045).
 *   - Idempotency uses the shared Neon HTTP handle, scoped to the
 *     operator's claims (see `tenant-idempotency.ts`).
 */

import { loadKeyPairFromPem, publicJwkOf, type Jwks, type SigningKey } from '@athlya/auth/jwt';
import {
  InvalidQRTokenError,
  QRReplayError,
  QR_TTL_SEC,
  generateAccessQR,
  verifyAccessQR,
  type ReplayStore,
} from '@athlya/auth/qr';
import { withTenant } from '@athlya/db/client';
import { classes, reservations, users, type ReservationRow } from '@athlya/db/schema';
import {
  checkIn,
  type CheckinReservationRepo,
  type CheckinWindow,
  type QRVerifier,
  type QRVerifyFailReason,
} from '@athlya/reservations/checkin';
import { and, asc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { decodeJwt, errors as joseErrors } from 'jose';

import { getOrCreateDbHttp, getOrCreateRedisForEnv, getOrCreateWriteDb } from './deps-cache.js';
import { createTenantIdempotencyDb } from './tenant-idempotency.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { CheckInOutcome, CheckinsDeps } from '../routes/checkins.js';
import type { AthlyaBindings } from '../types.js';
import type { AthlyaDb, TenantClaims } from '@athlya/db/client';
import type { CheckInRequest, CheckInResponse } from '@athlya/shared/schemas/api';
import type { Redis } from '@upstash/redis';

/** Redis key prefix of consumed QR `jti`s (Requirement 11.4). */
export const QR_REPLAY_PREFIX = 'qr:replay';

/**
 * Half-width of the reservation search band around `now`. Wider than
 * the ±30 min check-in window so the use case can answer
 * `outside_window` (too early or too late) instead of `no_reservation`.
 */
const SEARCH_BAND_MS = 2 * 60 * 60 * 1000;

function toTenantClaims(claims: AuthClaims): TenantClaims {
  return { userId: claims.userId, studioId: claims.studioId, role: claims.role };
}

/* ------------------------------------------------------------------ */
/*  Replay store                                                       */
/* ------------------------------------------------------------------ */

/**
 * Replay store whose `add` is the atomic consume: `SET NX` either
 * records the `jti` or proves another request already did, in which
 * case it throws {@link QRReplayError}. `verifyAccessQR` checks `has`
 * then calls `add`, so two kiosks scanning the same QR at once can both
 * pass `has`, but only one of them wins the `SET NX`.
 */
export function createAtomicReplayStore(
  redis: Pick<Redis, 'get' | 'set'>,
  prefix: string = QR_REPLAY_PREFIX,
): ReplayStore {
  return {
    async has(jti) {
      const existing = await redis.get<string>(`${prefix}:${jti}`);
      return existing !== null && existing !== undefined;
    },
    async add(jti, ttlSec) {
      const ex = Math.max(1, Math.floor(ttlSec));
      const result = await redis.set(`${prefix}:${jti}`, '1', { nx: true, ex });
      if (result === null) {
        throw new QRReplayError();
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/*  QR verifier                                                        */
/* ------------------------------------------------------------------ */

/**
 * Map a `verifyAccessQR` failure to the fine-grained reason the kiosk
 * displays. The payload is decoded only after the signature passed
 * (no jose `cause`), so `wrong_kind` / `wrong_studio` never echo an
 * unverified claim.
 */
export function qrFailReason(
  token: string,
  expectedStudioId: string,
  err: unknown,
): QRVerifyFailReason | undefined {
  if (err instanceof QRReplayError) return 'replay';
  if (!(err instanceof InvalidQRTokenError)) return undefined;
  const cause = err.cause;
  if (cause instanceof joseErrors.JWTExpired) return 'token_expired';
  if (
    cause instanceof joseErrors.JWSSignatureVerificationFailed ||
    cause instanceof joseErrors.JWKSNoMatchingKey
  ) {
    return 'invalid_signature';
  }
  if (cause !== undefined) return 'malformed';
  try {
    const payload = decodeJwt(token);
    if (payload['kind'] !== 'checkin') return 'wrong_kind';
    if (payload['studio'] !== expectedStudioId) return 'wrong_studio';
  } catch {
    return 'malformed';
  }
  return 'malformed';
}

/**
 * `verifyAccessQR` behind the {@link QRVerifier} port. `now` (Unix ms)
 * is the clock of the signature time window and of the replay TTL; it
 * is the same clock the check-in window uses.
 */
export function createQrVerifier(
  jwks: Jwks,
  replayStore: ReplayStore,
  now: () => number = Date.now,
): QRVerifier {
  return {
    async verify(token, expectedStudioId) {
      try {
        const verified = await verifyAccessQR(token, expectedStudioId, {
          jwks,
          replayStore,
          now: () => Math.floor(now() / 1000),
        });
        return { ok: true, ...verified };
      } catch (err) {
        const reason = qrFailReason(token, expectedStudioId, err);
        if (reason === undefined) throw err;
        return { ok: false, reason };
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Repository                                                         */
/* ------------------------------------------------------------------ */

/** `checkin_mark_reservation` stamped nothing: a concurrent check-in won. */
export class CheckinAlreadyStampedError extends Error {
  public override readonly name = 'CheckinAlreadyStampedError';

  public constructor() {
    super('reservation was checked in concurrently');
  }
}

type MarkedRow = Record<string, unknown>;

function rowsOf(result: unknown): MarkedRow[] {
  const rows: unknown = Array.isArray(result)
    ? result
    : (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as MarkedRow[]) : [];
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  return null;
}

function toReservationRow(row: MarkedRow): ReservationRow {
  return {
    id: String(row['id']),
    classId: String(row['class_id']),
    userId: String(row['user_id']),
    status: row['status'] as ReservationRow['status'],
    createdAt: toDate(row['created_at']) ?? new Date(0),
    cancelledAt: toDate(row['cancelled_at']),
    checkedInAt: toDate(row['checked_in_at']),
  };
}

export interface CheckinRepo extends CheckinReservationRepo {
  /** The member card the kiosk greets: same-studio users are visible to staff. */
  memberCard(userId: string): Promise<CheckInResponse['member'] | null>;
}

/**
 * Drizzle-backed check-in repo. Every statement runs in `withTenant`
 * with the operator's claims: `reservations_read_admin_same_studio`
 * and `users_read_same_studio` let an admin or a coach read the
 * member's rows of their own studio only, and the stamp goes through
 * the SECURITY DEFINER `checkin_mark_reservation`, which coaches may
 * call although `reservations_update_admin` admits admins only.
 */
export function createDrizzleCheckinRepo(db: AthlyaDb, claims: TenantClaims): CheckinRepo {
  return {
    async findConfirmedForCheckin(userId, studioId, window: CheckinWindow) {
      const mid = new Date((window.start.getTime() + window.end.getTime()) / 2);
      const [row] = await withTenant(db, claims, (tx) =>
        tx
          .select({ reservation: reservations, classStartsAt: classes.startsAt })
          .from(reservations)
          .innerJoin(classes, eq(classes.id, reservations.classId))
          .where(
            and(
              eq(reservations.userId, userId),
              eq(reservations.status, 'confirmed'),
              eq(classes.studioId, studioId),
              isNull(classes.deletedAt),
              gte(classes.startsAt, new Date(mid.getTime() - SEARCH_BAND_MS)),
              lte(classes.startsAt, new Date(mid.getTime() + SEARCH_BAND_MS)),
            ),
          )
          // A reservation still to check in wins over one already
          // stamped, then the class closest to now.
          .orderBy(
            sql`${reservations.checkedInAt} IS NOT NULL`,
            sql`abs(extract(epoch from (${classes.startsAt} - ${mid.toISOString()}::timestamptz)))`,
            asc(reservations.id),
          )
          .limit(1),
      );
      return row === undefined
        ? null
        : { reservation: row.reservation, classStartsAt: row.classStartsAt };
    },

    async markCheckedIn(reservationId, at) {
      const result: unknown = await withTenant(db, claims, (tx) =>
        tx.execute(
          sql`SELECT * FROM checkin_mark_reservation(${reservationId}::uuid, ${at.toISOString()}::timestamptz)`,
        ),
      );
      const [row] = rowsOf(result);
      if (row === undefined) {
        throw new CheckinAlreadyStampedError();
      }
      return toReservationRow(row);
    },

    async memberCard(userId) {
      const [row] = await withTenant(db, claims, (tx) =>
        tx
          .select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl })
          .from(users)
          .where(and(eq(users.id, userId), isNull(users.deletedAt)))
          .limit(1),
      );
      if (row === undefined) return null;
      return {
        id: row.id as CheckInResponse['member']['id'],
        displayName: row.displayName,
        avatarUrl: row.avatarUrl,
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Key material                                                       */
/* ------------------------------------------------------------------ */

interface QrKeys {
  readonly signingKey: SigningKey;
  readonly jwks: Jwks;
}

const keyCache = new Map<string, Promise<QrKeys>>();

/** Test seam: drop the cached key material. */
export function __resetCheckinKeysForTests(): void {
  keyCache.clear();
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The RS256 key pair and the verification JWKS. `JWKS_JSON` carries the
 * previous key too during a rotation, so a QR minted just before the
 * switch still verifies; without it the current public key is used.
 */
function loadQrKeys(env: AthlyaBindings): Promise<QrKeys> {
  const wider = env as AthlyaBindings & {
    JWT_KID?: string;
    JWT_PRIVATE_KEY_PEM?: string;
    JWT_PUBLIC_KEY_PEM?: string;
    JWKS_JSON?: string;
  };
  const { JWT_KID: kid, JWT_PRIVATE_KEY_PEM: privatePem, JWT_PUBLIC_KEY_PEM: publicPem } = wider;
  if (!nonEmpty(kid) || !nonEmpty(privatePem) || !nonEmpty(publicPem)) {
    return Promise.reject(
      new Error(
        'check-in tokens need JWT_KID, JWT_PRIVATE_KEY_PEM and JWT_PUBLIC_KEY_PEM on this Worker',
      ),
    );
  }
  const cacheKey = `${kid}::${wider.JWKS_JSON ?? ''}`;
  let pending = keyCache.get(cacheKey);
  if (pending === undefined) {
    pending = (async () => {
      const signingKey = await loadKeyPairFromPem(privatePem, publicPem, kid);
      const jwks: Jwks = nonEmpty(wider.JWKS_JSON)
        ? (JSON.parse(wider.JWKS_JSON) as Jwks)
        : { keys: [{ ...(await publicJwkOf(signingKey)), kid, alg: 'RS256', use: 'sig' }] };
      return { signingKey, jwks };
    })();
    pending.catch(() => keyCache.delete(cacheKey));
    keyCache.set(cacheKey, pending);
  }
  return pending;
}

/* ------------------------------------------------------------------ */
/*  Use case                                                           */
/* ------------------------------------------------------------------ */

export interface CheckInPorts {
  readonly repo: CheckinRepo;
  readonly qrVerifier: QRVerifier;
  readonly now: () => number;
}

/**
 * Run the `@athlya/reservations` check-in for `operator` and shape the
 * kiosk outcome. The token is checked against the operator's studio, so
 * another studio's QR answers `wrong_studio`; a stamp lost to a
 * concurrent scan answers `already_checked_in`.
 */
export async function checkInWith(
  operator: AuthClaims,
  input: CheckInRequest,
  ports: CheckInPorts,
): Promise<CheckInOutcome> {
  let result: Awaited<ReturnType<typeof checkIn>>;
  try {
    result = await checkIn({
      token: input.qrToken,
      studioId: operator.studioId,
      qrVerifier: ports.qrVerifier,
      repo: ports.repo,
      clock: ports.now,
    });
  } catch (err) {
    if (err instanceof CheckinAlreadyStampedError) {
      return { kind: 'fail', reason: 'already_checked_in' };
    }
    throw err;
  }

  if (result.code !== 'ok') {
    return { kind: 'fail', reason: result.code };
  }
  const member = await ports.repo.memberCard(result.reservation.userId);
  return {
    kind: 'success',
    reservationId: result.reservation.id as CheckInResponse['reservationId'],
    member: member ?? {
      id: result.reservation.userId as CheckInResponse['member']['id'],
      displayName: '',
      avatarUrl: null,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Bundle                                                             */
/* ------------------------------------------------------------------ */

export interface CheckinsDepsOverrides {
  /** Injectable clock (Unix ms), for tests. */
  readonly now?: () => number;
}

export function buildCheckinsDeps(
  env: AthlyaBindings,
  overrides: CheckinsDepsOverrides = {},
): CheckinsDeps {
  const now = overrides.now ?? Date.now;

  return {
    async issueToken(claims) {
      const { signingKey } = await loadQrKeys(env);
      const iat = Math.floor(now() / 1000);
      const token = await generateAccessQR(claims.userId, claims.studioId, {
        signingKey,
        now: () => iat,
      });
      return { token, expiresAt: new Date((iat + QR_TTL_SEC) * 1000).toISOString() };
    },

    async checkIn(operator, input) {
      const { jwks } = await loadQrKeys(env);
      return checkInWith(operator, input, {
        repo: createDrizzleCheckinRepo(getOrCreateWriteDb(env), toTenantClaims(operator)),
        qrVerifier: createQrVerifier(
          jwks,
          createAtomicReplayStore(getOrCreateRedisForEnv(env)),
          now,
        ),
        now,
      });
    },

    idempotencyFor(claims) {
      return {
        db: createTenantIdempotencyDb(getOrCreateDbHttp(env.DB_URL), toTenantClaims(claims)),
      };
    },
  };
}
