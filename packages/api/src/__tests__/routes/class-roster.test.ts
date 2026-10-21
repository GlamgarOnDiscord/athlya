/**
 * `/v1/classes/:id/roster` and its manual check-in, and the admin member
 * file `GET /v1/members/:id`, with a valid session (issue #746).
 *
 * Covers the role gates, the outcome to HTTP mapping, the no-store
 * header on personal data and the path validation.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetJwksCacheForTests } from '../../middleware/auth.js';
import { buildApp } from '../../worker.js';
import { readJson } from '../helpers/read-json.js';

import {
  TEST_STUDIO_ID,
  TEST_USER_ID,
  buildLocalResolver,
  buildStubDeps,
  env,
  mintAuthJwt,
  mintTestKeypair,
  type TestKeypair,
} from './route-test-helpers.js';

import type { JwksKeyResolver } from '../../middleware/auth.js';
import type { RosterCheckInFailReason } from '../../routes/classes.js';
import type { ClassRosterResponse, MemberFileResponse } from '@athlya/shared/schemas/api';

const hoisted = vi.hoisted(() => ({
  localResolver: null as JwksKeyResolver | null,
}));

vi.mock('jose', async () => {
  const actual = await vi.importActual<typeof import('jose')>('jose');
  return {
    ...actual,
    createRemoteJWKSet: () =>
      (async (...args: Parameters<JwksKeyResolver>) => {
        if (hoisted.localResolver === null) {
          throw new Error('local resolver not initialised');
        }
        return hoisted.localResolver(...args);
      }) as JwksKeyResolver,
  };
});

const CLASS_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccc01';
const RESERVATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddd01';
const MEMBER_ID = '11111111-1111-4111-8111-111111111111';

const ENTRY = {
  reservationId: RESERVATION_ID,
  status: 'confirmed' as const,
  bookedAt: '2030-01-01T08:00:00.000Z',
  checkedInAt: '2030-01-01T09:01:00.000Z',
  member: { id: MEMBER_ID, displayName: 'Ada', avatarUrl: null },
};

const ROSTER: ClassRosterResponse = {
  class: {
    id: CLASS_ID,
    title: 'Hyrox',
    startsAt: '2030-01-01T09:00:00.000Z',
    durationMin: 60,
    capacity: 12,
    coach: null,
  },
  confirmed: [ENTRY],
  waitlist: [],
  attendance: { opensAt: '2030-01-01T08:30:00.000Z', closesAt: '2030-01-02T10:00:00.000Z' },
};

const FILE: MemberFileResponse = {
  member: {
    id: MEMBER_ID,
    email: 'ada@example.com',
    displayName: 'Ada',
    avatarUrl: null,
    role: 'member',
    consents: {
      marketing: false,
      analytics: true,
      thirdParty: false,
      version: '2026-01',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  upcoming: [],
  past: [],
  stats: { checkIns: 0, lastCheckInAt: null, noShows: 0, cancellations: 0 },
};

let kp: TestKeypair;

beforeAll(async () => {
  kp = await mintTestKeypair();
  hoisted.localResolver = buildLocalResolver(kp.publicJwk);
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  __resetJwksCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function call(
  deps: ReturnType<typeof buildStubDeps>,
  path: string,
  method: 'GET' | 'POST',
  role: 'member' | 'coach' | 'admin',
): Promise<Response> {
  const token = await mintAuthJwt(kp, { role });
  return buildApp({ deps }).request(
    path,
    { method, headers: { authorization: `Bearer ${token}` } },
    env(),
  );
}

const rosterPath = `/v1/classes/${CLASS_ID}/roster`;
const checkInPath = `${rosterPath}/${RESERVATION_ID}/check-in`;

describe('GET /v1/classes/:id/roster', () => {
  it('serves the roster to an admin, uncached', async () => {
    const getRoster = vi.fn().mockResolvedValue({ kind: 'ok', roster: ROSTER });
    const deps = buildStubDeps({ classes: { getRoster } });

    const res = await call(deps, rosterPath, 'GET', 'admin');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await readJson<ClassRosterResponse>(res)).toEqual(ROSTER);
    expect(getRoster).toHaveBeenCalledWith(
      CLASS_ID,
      expect.objectContaining({ userId: TEST_USER_ID, studioId: TEST_STUDIO_ID, role: 'admin' }),
    );
  });

  it('answers 403 not_class_coach to a coach of another class', async () => {
    const getRoster = vi.fn().mockResolvedValue({ kind: 'forbidden' });
    const deps = buildStubDeps({ classes: { getRoster } });

    const res = await call(deps, rosterPath, 'GET', 'coach');

    expect(res.status).toBe(403);
    expect(await readJson<{ code: string }>(res)).toMatchObject({ code: 'not_class_coach' });
  });

  it('answers 404 for a class outside the studio', async () => {
    const getRoster = vi.fn().mockResolvedValue({ kind: 'not_found' });
    const deps = buildStubDeps({ classes: { getRoster } });

    const res = await call(deps, rosterPath, 'GET', 'admin');

    expect(res.status).toBe(404);
  });

  it('refuses a member before reading anything', async () => {
    const deps = buildStubDeps();
    const res = await call(deps, rosterPath, 'GET', 'member');
    expect(res.status).toBe(403);
    expect(deps.classes.getRoster).not.toHaveBeenCalled();
  });

  it('rejects a class id that is not a uuid', async () => {
    const deps = buildStubDeps();
    const res = await call(deps, '/v1/classes/not-a-uuid/roster', 'GET', 'admin');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(deps.classes.getRoster).not.toHaveBeenCalled();
  });

  it('requires a session', async () => {
    const deps = buildStubDeps();
    const res = await buildApp({ deps }).request(rosterPath, { method: 'GET' }, env());
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/classes/:id/roster/:reservationId/check-in', () => {
  it('returns the checked-in entry to the coach of the class', async () => {
    const markAttendance = vi.fn().mockResolvedValue({ kind: 'checked_in', entry: ENTRY });
    const deps = buildStubDeps({ classes: { markAttendance } });

    const res = await call(deps, checkInPath, 'POST', 'coach');

    expect(res.status).toBe(200);
    expect(await readJson<unknown>(res)).toEqual(ENTRY);
    expect(markAttendance).toHaveBeenCalledWith(
      CLASS_ID,
      RESERVATION_ID,
      expect.objectContaining({ role: 'coach' }),
    );
  });

  it.each<[RosterCheckInFailReason, number]>([
    ['not_confirmed', 422],
    ['already_checked_in', 422],
    ['outside_window', 422],
    ['checkin_limit_reached', 429],
  ])('maps %s to %i with its code', async (reason, status) => {
    const markAttendance = vi.fn().mockResolvedValue({ kind: 'fail', reason });
    const deps = buildStubDeps({ classes: { markAttendance } });

    const res = await call(deps, checkInPath, 'POST', 'admin');

    expect(res.status).toBe(status);
    expect(await readJson<{ code: string }>(res)).toMatchObject({ code: reason });
    expect(res.headers.get('retry-after')).toBe(status === 429 ? '3600' : null);
  });

  it('maps forbidden and not_found', async () => {
    const markAttendance = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'forbidden' })
      .mockResolvedValueOnce({ kind: 'not_found' });
    const deps = buildStubDeps({ classes: { markAttendance } });

    expect((await call(deps, checkInPath, 'POST', 'coach')).status).toBe(403);
    expect((await call(deps, checkInPath, 'POST', 'coach')).status).toBe(404);
  });

  it('refuses a member', async () => {
    const deps = buildStubDeps();
    const res = await call(deps, checkInPath, 'POST', 'member');
    expect(res.status).toBe(403);
    expect(deps.classes.markAttendance).not.toHaveBeenCalled();
  });
});

describe('GET /v1/members/:id', () => {
  const filePath = `/v1/members/${MEMBER_ID}`;

  it('serves the member file to an admin, uncached', async () => {
    const getMemberFile = vi.fn().mockResolvedValue(FILE);
    const deps = buildStubDeps({ members: { getMemberFile } });

    const res = await call(deps, filePath, 'GET', 'admin');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await readJson<MemberFileResponse>(res)).toEqual(FILE);
    expect(getMemberFile).toHaveBeenCalledWith(
      MEMBER_ID,
      expect.objectContaining({ studioId: TEST_STUDIO_ID, role: 'admin' }),
    );
  });

  it('answers 404 member_not_found when there is no such member', async () => {
    const getMemberFile = vi.fn().mockResolvedValue(null);
    const deps = buildStubDeps({ members: { getMemberFile } });

    const res = await call(deps, filePath, 'GET', 'admin');

    expect(res.status).toBe(404);
    expect(await readJson<{ code: string }>(res)).toMatchObject({ code: 'member_not_found' });
  });

  it.each(['coach', 'member'] as const)('refuses a %s', async (role) => {
    const deps = buildStubDeps();
    const res = await call(deps, filePath, 'GET', role);
    expect(res.status).toBe(403);
    expect(deps.members.getMemberFile).not.toHaveBeenCalled();
  });

  it('still routes /v1/members/me to the caller profile', async () => {
    const getProfile = vi.fn().mockResolvedValue({ id: TEST_USER_ID });
    const deps = buildStubDeps({ members: { getProfile } });

    const res = await call(deps, '/v1/members/me', 'GET', 'admin');

    expect(res.status).toBe(200);
    expect(getProfile).toHaveBeenCalled();
    expect(deps.members.getMemberFile).not.toHaveBeenCalled();
  });
});
