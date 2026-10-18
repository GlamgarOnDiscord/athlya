/**
 * QR check-in end to end against the real migration chain, run as the
 * `athlya_app` runtime role (issue #654).
 *
 * Tokens are minted with `generateAccessQR` and a real RS256 key, the
 * replay store is the atomic `SET NX` store over an in-memory Redis
 * double, and the reservation lookup + stamp go through
 * `createDrizzleCheckinRepo` under the operator's claims, so the
 * assertions below are what RLS and `checkin_mark_reservation`
 * (migration 0045) let a coach do.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicJwkOf, type Jwks, type SigningKey } from '@athlya/auth/jwt';
import { generateAccessQR } from '@athlya/auth/qr';
import * as schema from '@athlya/db/schema';
import { PGlite } from '@electric-sql/pglite';
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { drizzle } from 'drizzle-orm/pglite';
import { SignJWT, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CheckinAlreadyStampedError,
  checkInWith,
  createAtomicReplayStore,
  createDrizzleCheckinRepo,
  createQrVerifier,
} from '../../adapters/checkins-deps.js';

import type { AuthClaims } from '../../middleware/auth.js';
import type { AthlyaDb, TenantClaims } from '@athlya/db/client';
import type { Redis } from '@upstash/redis';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../../../db/migrations');

const STUDIO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STUDIO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBER_A = '11111111-1111-4111-8111-111111111111';
const MEMBER_A2 = '11111111-1111-4111-8111-111111111112';
const MEMBER_A3 = '11111111-1111-4111-8111-111111111115';
const COACH_A = '11111111-1111-4111-8111-111111111114';
const MEMBER_B = '22222222-2222-4222-8222-222222222221';
const COACH_B = '22222222-2222-4222-8222-222222222224';
const CLASS_NOW = 'cccccccc-cccc-4ccc-8ccc-ccccccccc001';
const CLASS_LATER = 'cccccccc-cccc-4ccc-8ccc-ccccccccc002';
const CLASS_B = 'cccccccc-cccc-4ccc-8ccc-ccccccccc003';
const RES_A = 'dddddddd-dddd-4ddd-8ddd-ddddddddd001';
const RES_A2 = 'dddddddd-dddd-4ddd-8ddd-ddddddddd002';
const RES_B = 'dddddddd-dddd-4ddd-8ddd-ddddddddd003';

/** The kiosk clock: 15 minutes before CLASS_NOW starts. */
const NOW_MS = Date.parse('2030-01-01T08:45:00Z');
const nowSec = (): number => Math.floor(NOW_MS / 1000);

const coachA = { userId: COACH_A, studioId: STUDIO_A, role: 'coach' } as AuthClaims;
const coachB = { userId: COACH_B, studioId: STUDIO_B, role: 'coach' } as AuthClaims;

let pglite: PGlite;
let db: AthlyaDb;
let signingKey: SigningKey;
let jwks: Jwks;

/** In-memory double of the Upstash `get` / `set` subset, with `NX`. */
function memoryRedis(): Pick<Redis, 'get' | 'set'> {
  const keys = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(keys.get(key) ?? null),
    set: (key: string, value: string, opts?: { nx?: boolean }) => {
      if (opts?.nx === true && keys.has(key)) return Promise.resolve(null);
      keys.set(key, value);
      return Promise.resolve('OK');
    },
  } as unknown as Pick<Redis, 'get' | 'set'>;
}

const tenant = (claims: AuthClaims): TenantClaims => ({
  userId: claims.userId,
  studioId: claims.studioId,
  role: claims.role,
});

function ports(operator: AuthClaims, redis = memoryRedis()) {
  return {
    repo: createDrizzleCheckinRepo(db, tenant(operator)),
    qrVerifier: createQrVerifier(jwks, createAtomicReplayStore(redis), () => NOW_MS),
    now: () => NOW_MS,
  };
}

const qr = (userId: string, studioId = STUDIO_A, iat = nowSec()) =>
  generateAccessQR(userId, studioId, { signingKey, now: () => iat });

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  signingKey = { kid: 'qr-test', privateKey: pair.privateKey, publicKey: pair.publicKey };
  jwks = { keys: [{ ...(await publicJwkOf(signingKey)), kid: 'qr-test', alg: 'RS256' }] };

  pglite = new PGlite({ extensions: { btree_gin, citext, pgcrypto } });
  const forward = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  for (const file of forward) {
    const body = readFileSync(resolve(migrationsDir, file), 'utf8');
    await pglite.exec(body.replace(/\bCONCURRENTLY\b/gu, ''));
  }
  await pglite.exec(`
    INSERT INTO studios (id, slug, name) VALUES
      ('${STUDIO_A}', 'studio-a', 'Studio A'),
      ('${STUDIO_B}', 'studio-b', 'Studio B');
    INSERT INTO users (id, studio_id, email, display_name, role, consents, avatar_url)
    SELECT id::uuid, studio::uuid, email, name, role::user_role,
           '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb,
           avatar
      FROM (VALUES
        ('${MEMBER_A}',  '${STUDIO_A}', 'member-a@test.dev',  'Member A',  'member', 'https://avatars.athlya.app/a.jpg'),
        ('${MEMBER_A2}', '${STUDIO_A}', 'member-a2@test.dev', 'Member A2', 'member', NULL),
        ('${MEMBER_A3}', '${STUDIO_A}', 'member-a3@test.dev', 'Member A3', 'member', NULL),
        ('${COACH_A}',   '${STUDIO_A}', 'coach-a@test.dev',   'Coach A',   'coach',  NULL),
        ('${MEMBER_B}',  '${STUDIO_B}', 'member-b@test.dev',  'Member B',  'member', NULL),
        ('${COACH_B}',   '${STUDIO_B}', 'coach-b@test.dev',   'Coach B',   'coach',  NULL)
      ) AS seed (id, studio, email, name, role, avatar);
    INSERT INTO classes (id, studio_id, title, starts_at, duration_min, capacity, version) VALUES
      ('${CLASS_NOW}',   '${STUDIO_A}', 'Now',   '2030-01-01 09:00:00+00', 60, 10, 0),
      ('${CLASS_LATER}', '${STUDIO_A}', 'Later', '2030-01-01 10:00:00+00', 60, 10, 0),
      ('${CLASS_B}',     '${STUDIO_B}', 'B',     '2030-01-01 09:00:00+00', 60, 10, 0);
    INSERT INTO reservations (id, class_id, user_id, status) VALUES
      ('${RES_A}',  '${CLASS_NOW}',   '${MEMBER_A}',  'confirmed'),
      ('${RES_A2}', '${CLASS_LATER}', '${MEMBER_A2}', 'confirmed'),
      ('${RES_B}',  '${CLASS_B}',     '${MEMBER_B}',  'confirmed');
    SET ROLE athlya_app;
  `);
  db = drizzle(pglite, { schema }) as unknown as AthlyaDb;
}, 120_000);

afterAll(async () => {
  await pglite.close();
});

describe('QR check-in under athlya_app', () => {
  it('a coach checks the member in once; the same token is then a replay', async () => {
    const redis = memoryRedis();
    const token = await qr(MEMBER_A);

    const first = await checkInWith(coachA, { qrToken: token }, ports(coachA, redis));
    expect(first).toEqual({
      kind: 'success',
      reservationId: RES_A,
      member: {
        id: MEMBER_A,
        displayName: 'Member A',
        avatarUrl: 'https://avatars.athlya.app/a.jpg',
      },
    });

    const replay = await checkInWith(coachA, { qrToken: token }, ports(coachA, redis));
    expect(replay).toEqual({ kind: 'fail', reason: 'replay' });
  });

  it('a fresh token for a member already checked in answers already_checked_in', async () => {
    const outcome = await checkInWith(coachA, { qrToken: await qr(MEMBER_A) }, ports(coachA));
    expect(outcome).toEqual({ kind: 'fail', reason: 'already_checked_in' });
  });

  it('a class starting in 75 minutes is outside the ±30 min window', async () => {
    const outcome = await checkInWith(coachA, { qrToken: await qr(MEMBER_A2) }, ports(coachA));
    expect(outcome).toEqual({ kind: 'fail', reason: 'outside_window' });
  });

  it('a member without a reservation answers no_reservation', async () => {
    const outcome = await checkInWith(coachA, { qrToken: await qr(MEMBER_A3) }, ports(coachA));
    expect(outcome).toEqual({ kind: 'fail', reason: 'no_reservation' });
  });

  it("another studio's QR answers wrong_studio before any database read", async () => {
    const outcome = await checkInWith(
      coachA,
      { qrToken: await qr(MEMBER_B, STUDIO_B) },
      ports(coachA),
    );
    expect(outcome).toEqual({ kind: 'fail', reason: 'wrong_studio' });
  });

  it('a token older than 120 s answers token_expired', async () => {
    const stale = await qr(MEMBER_A3, STUDIO_A, nowSec() - 121);
    const outcome = await checkInWith(coachA, { qrToken: stale }, ports(coachA));
    expect(outcome).toEqual({ kind: 'fail', reason: 'token_expired' });
  });

  it('a token signed by another key answers invalid_signature', async () => {
    const other = await generateKeyPair('RS256');
    const forged = await generateAccessQR(MEMBER_A3, STUDIO_A, {
      signingKey: { kid: 'qr-test', privateKey: other.privateKey, publicKey: other.publicKey },
      now: nowSec,
    });
    const outcome = await checkInWith(coachA, { qrToken: forged }, ports(coachA));
    expect(outcome).toEqual({ kind: 'fail', reason: 'invalid_signature' });
  });

  it('an access token presented as a QR answers wrong_kind', async () => {
    const access = await new SignJWT({ studio: STUDIO_A, role: 'member' })
      .setProtectedHeader({ alg: 'RS256', kid: 'qr-test' })
      .setSubject(MEMBER_A3)
      .setIssuedAt(nowSec())
      .setExpirationTime(nowSec() + 60)
      .setJti('access-1')
      .sign(signingKey.privateKey);
    const outcome = await checkInWith(coachA, { qrToken: access }, ports(coachA));
    expect(outcome).toEqual({ kind: 'fail', reason: 'wrong_kind' });
  });

  it('garbage answers malformed', async () => {
    const outcome = await checkInWith(coachA, { qrToken: 'not-a-jwt' }, ports(coachA));
    expect(outcome).toEqual({ kind: 'fail', reason: 'malformed' });
  });

  it('two kiosks scanning the same QR at once check in exactly once', async () => {
    const redis = memoryRedis();
    const verifier = createQrVerifier(jwks, createAtomicReplayStore(redis), () => NOW_MS);
    const token = await qr(MEMBER_B, STUDIO_B);
    const results = await Promise.all([
      verifier.verify(token, STUDIO_B),
      verifier.verify(token, STUDIO_B),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'replay' }]);
  });

  it('the stamp is single: a second markCheckedIn throws CheckinAlreadyStampedError', async () => {
    const repo = createDrizzleCheckinRepo(db, tenant(coachB));
    const at = new Date(NOW_MS);
    const row = await repo.markCheckedIn(RES_B, at);
    expect(row.checkedInAt?.toISOString()).toBe(at.toISOString());
    expect(row.status).toBe('confirmed');
    await expect(repo.markCheckedIn(RES_B, at)).rejects.toBeInstanceOf(CheckinAlreadyStampedError);
  });

  it("another studio's coach sees neither the reservation nor the member", async () => {
    const repo = createDrizzleCheckinRepo(db, tenant(coachB));
    const window = { start: new Date(NOW_MS - 1_800_000), end: new Date(NOW_MS + 1_800_000) };
    expect(await repo.findConfirmedForCheckin(MEMBER_A, STUDIO_A, window)).toBeNull();
    expect(await repo.memberCard(MEMBER_A)).toBeNull();
    await expect(repo.markCheckedIn(RES_A2, new Date(NOW_MS))).rejects.toBeInstanceOf(
      CheckinAlreadyStampedError,
    );
  });
});
