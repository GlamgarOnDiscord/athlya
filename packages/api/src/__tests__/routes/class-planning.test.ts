/**
 * Rooms, weekly series and schedule conflicts on the `/v1/classes/*`
 * routes (issue #748).
 *
 * Covers authentication, the admin role gate, Zod validation, the
 * outcome to HTTP mapping of every rooms and series route, the 409
 * `schedule_conflict` body and its `allowConflicts` override on the
 * single-class create and update, and that `/rooms` and `/series` are
 * not swallowed by the classes router's `/:id` routes.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetJwksCacheForTests } from '../../middleware/auth.js';
import { buildApp } from '../../worker.js';
import { readJson } from '../helpers/read-json.js';

import {
  TEST_STUDIO_ID,
  buildLocalResolver,
  buildStubDeps,
  env,
  mintAuthJwt,
  mintTestKeypair,
  type TestKeypair,
} from './route-test-helpers.js';

import type { JwksKeyResolver } from '../../middleware/auth.js';
import type { Room, ScheduleConflictItem } from '@athlya/shared/schemas/api';

const hoisted = vi.hoisted(() => ({ localResolver: null as JwksKeyResolver | null }));

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

const ROOM_ID = '0a510000-0000-4000-8000-000000000001';
const SERIES_ID = '0f510000-0000-4000-8000-000000000001';
const CLASS_ID = '0c510000-0000-4000-8000-000000000001';

const ROOM: Room = {
  id: ROOM_ID,
  studioId: TEST_STUDIO_ID,
  name: 'Studio 1',
  capacity: 20,
  createdAt: '2026-10-01T08:00:00.000Z',
} as Room;

const CONFLICT: ScheduleConflictItem = {
  occurrenceStartsAt: '2099-01-05T09:00:00.000Z',
  classId: CLASS_ID,
  title: 'Yoga',
  startsAt: '2099-01-05T08:30:00.000Z',
  durationMin: 60,
  reasons: ['room'],
} as ScheduleConflictItem;

const SERIES_BODY = {
  title: 'Morning flow',
  startsAt: '2099-01-05T09:00:00.000Z',
  durationMin: 60,
  capacity: 12,
  roomId: ROOM_ID,
  recurrence: { weekdays: [1, 3], count: 4 },
  timeZone: 'Europe/Paris',
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

type Role = 'member' | 'coach' | 'admin';

async function call(
  deps: ReturnType<typeof buildStubDeps>,
  method: string,
  path: string,
  options: { role?: Role; body?: unknown } = {},
): Promise<Response> {
  const token = await mintAuthJwt(kp, { role: options.role ?? 'admin' });
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return buildApp({ deps }).request(
    `/v1/classes${path}`,
    {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    },
    env(),
  );
}

describe('authentication', () => {
  it.each([
    ['GET', '/rooms'],
    ['POST', '/rooms'],
    ['POST', '/series'],
    ['DELETE', `/series/${SERIES_ID}?fromClassId=${CLASS_ID}`],
  ])('%s /v1/classes%s without a token is 401', async (method, path) => {
    const deps = buildStubDeps();
    const res = await buildApp({ deps }).request(`/v1/classes${path}`, { method }, env());
    expect(res.status).toBe(401);
    expect(deps.planning.listRooms).not.toHaveBeenCalled();
    expect(deps.planning.createSeries).not.toHaveBeenCalled();
  });
});

describe('rooms', () => {
  it.each<Role>(['member', 'coach', 'admin'])('GET /rooms is open to a %s', async (role) => {
    const deps = buildStubDeps({ planning: { listRooms: vi.fn().mockResolvedValue([ROOM]) } });
    const res = await call(deps, 'GET', '/rooms', { role });
    expect(res.status).toBe(200);
    expect(await readJson<{ items: Room[] }>(res)).toEqual({ items: [ROOM] });
    expect(deps.planning.listRooms).toHaveBeenCalledWith(
      expect.objectContaining({ studioId: TEST_STUDIO_ID, role }),
    );
    expect(deps.classes.listClasses).not.toHaveBeenCalled();
  });

  it.each<Role>(['member', 'coach'])('a %s cannot create, edit or delete a room', async (role) => {
    const deps = buildStubDeps();
    expect((await call(deps, 'POST', '/rooms', { role, body: { name: 'X' } })).status).toBe(403);
    expect(
      (await call(deps, 'PATCH', `/rooms/${ROOM_ID}`, { role, body: { name: 'X' } })).status,
    ).toBe(403);
    expect((await call(deps, 'DELETE', `/rooms/${ROOM_ID}`, { role })).status).toBe(403);
    expect(deps.planning.createRoom).not.toHaveBeenCalled();
    expect(deps.planning.updateRoom).not.toHaveBeenCalled();
    expect(deps.planning.deleteRoom).not.toHaveBeenCalled();
  });

  it('POST /rooms creates with a trimmed name and answers 201', async () => {
    const createRoom = vi.fn().mockResolvedValue({ kind: 'ok', room: ROOM });
    const deps = buildStubDeps({ planning: { createRoom } });
    const res = await call(deps, 'POST', '/rooms', { body: { name: '  Studio 1 ', capacity: 20 } });
    expect(res.status).toBe(201);
    expect(await readJson<Room>(res)).toEqual(ROOM);
    expect(createRoom).toHaveBeenCalledWith(expect.anything(), { name: 'Studio 1', capacity: 20 });
  });

  it('POST /rooms validates the name, the capacity and unknown keys', async () => {
    const deps = buildStubDeps();
    for (const body of [
      { name: '' },
      { name: 'x'.repeat(81) },
      { name: 'A', capacity: 0 },
      { name: 'A', capacity: 501 },
      { name: 'A', studioId: TEST_STUDIO_ID },
    ]) {
      expect((await call(deps, 'POST', '/rooms', { body })).status).toBe(422);
    }
    expect(deps.planning.createRoom).not.toHaveBeenCalled();
  });

  it('a taken name is 409 room_name_taken', async () => {
    const deps = buildStubDeps({
      planning: {
        createRoom: vi.fn().mockResolvedValue({ kind: 'name_taken' }),
        updateRoom: vi.fn().mockResolvedValue({ kind: 'name_taken' }),
      },
    });
    const created = await call(deps, 'POST', '/rooms', { body: { name: 'Studio 1' } });
    expect(created.status).toBe(409);
    expect(await readJson<{ code: string }>(created)).toMatchObject({ code: 'room_name_taken' });
    const renamed = await call(deps, 'PATCH', `/rooms/${ROOM_ID}`, { body: { name: 'Studio 1' } });
    expect(renamed.status).toBe(409);
  });

  it('PATCH /rooms/:roomId clears the capacity with null, 404 for an unknown room', async () => {
    const updateRoom = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'ok', room: { ...ROOM, capacity: null } })
      .mockResolvedValueOnce({ kind: 'not_found' });
    const deps = buildStubDeps({ planning: { updateRoom } });
    const res = await call(deps, 'PATCH', `/rooms/${ROOM_ID}`, { body: { capacity: null } });
    expect(res.status).toBe(200);
    expect(updateRoom).toHaveBeenCalledWith(expect.anything(), ROOM_ID, { capacity: null });
    expect((await call(deps, 'PATCH', `/rooms/${ROOM_ID}`, { body: { name: 'B' } })).status).toBe(
      404,
    );
  });

  it('PATCH /rooms/:roomId needs a field and a uuid', async () => {
    const deps = buildStubDeps();
    expect((await call(deps, 'PATCH', `/rooms/${ROOM_ID}`, { body: {} })).status).toBe(422);
    expect((await call(deps, 'PATCH', '/rooms/nope', { body: { name: 'B' } })).status).toBe(422);
  });

  it('DELETE /rooms/:roomId is 204, then 404', async () => {
    const deleteRoom = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'deleted' })
      .mockResolvedValueOnce({ kind: 'not_found' });
    const deps = buildStubDeps({ planning: { deleteRoom } });
    expect((await call(deps, 'DELETE', `/rooms/${ROOM_ID}`)).status).toBe(204);
    expect((await call(deps, 'DELETE', `/rooms/${ROOM_ID}`)).status).toBe(404);
    expect(deps.classes.deleteClass).not.toHaveBeenCalled();
  });
});

describe('series', () => {
  it('a member or a coach cannot touch a series', async () => {
    const deps = buildStubDeps();
    expect((await call(deps, 'POST', '/series', { role: 'coach', body: SERIES_BODY })).status).toBe(
      403,
    );
    expect(
      (
        await call(deps, 'DELETE', `/series/${SERIES_ID}?fromClassId=${CLASS_ID}`, {
          role: 'member',
        })
      ).status,
    ).toBe(403);
    expect(deps.planning.createSeries).not.toHaveBeenCalled();
    expect(deps.planning.deleteSeries).not.toHaveBeenCalled();
  });

  it('POST /series creates and answers 201 with the series id and its classes', async () => {
    const createSeries = vi
      .fn()
      .mockResolvedValue({ kind: 'created', seriesId: SERIES_ID, items: [] });
    const deps = buildStubDeps({ planning: { createSeries } });
    const res = await call(deps, 'POST', '/series', { body: SERIES_BODY });
    expect(res.status).toBe(201);
    expect(await readJson<{ seriesId: string }>(res)).toEqual({ seriesId: SERIES_ID, items: [] });
    expect(createSeries).toHaveBeenCalledWith(expect.anything(), SERIES_BODY);
    expect(deps.classes.createClass).not.toHaveBeenCalled();
  });

  it('POST /series validates the recurrence and the time zone', async () => {
    const deps = buildStubDeps();
    for (const recurrence of [
      { weekdays: [], count: 4 },
      { weekdays: [8], count: 4 },
      { weekdays: [1, 1], count: 4 },
      { weekdays: [1] },
      { weekdays: [1], count: 4, until: '2099-02-01' },
      { weekdays: [1], count: 61 },
      { weekdays: [1], until: '2099-02-31' },
    ]) {
      expect(
        (await call(deps, 'POST', '/series', { body: { ...SERIES_BODY, recurrence } })).status,
      ).toBe(422);
    }
    expect(
      (await call(deps, 'POST', '/series', { body: { ...SERIES_BODY, timeZone: 'Mars/Olympus' } }))
        .status,
    ).toBe(422);
    expect(deps.planning.createSeries).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'starts_at_in_past' }, 422, 'starts_at_in_past'],
    [{ kind: 'invalid_recurrence', reason: 'no_occurrences' }, 422, 'no_occurrences'],
    [{ kind: 'invalid_recurrence', reason: 'too_many_occurrences' }, 422, 'too_many_occurrences'],
    [{ kind: 'room_not_found' }, 422, 'room_not_found'],
    [{ kind: 'schedule_conflict', conflicts: [CONFLICT] }, 409, 'schedule_conflict'],
  ])('POST /series maps %o to %i %s', async (outcome, status, code) => {
    const deps = buildStubDeps({ planning: { createSeries: vi.fn().mockResolvedValue(outcome) } });
    const res = await call(deps, 'POST', '/series', { body: SERIES_BODY });
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await readJson<{ code: string }>(res)).toMatchObject({ code });
  });

  it('PATCH /series/:seriesId forwards the anchor, its version and the new start time', async () => {
    const updateSeries = vi.fn().mockResolvedValue({ kind: 'updated', items: [] });
    const deps = buildStubDeps({ planning: { updateSeries } });
    const body = {
      fromClassId: CLASS_ID,
      version: 2,
      startTime: '18:30',
      timeZone: 'Europe/Paris',
      roomId: null,
    };
    const res = await call(deps, 'PATCH', `/series/${SERIES_ID}`, { body });
    expect(res.status).toBe(200);
    expect(updateSeries).toHaveBeenCalledWith(expect.anything(), SERIES_ID, body);
  });

  it('PATCH /series/:seriesId needs a field, and startTime with a time zone', async () => {
    const deps = buildStubDeps();
    const base = { fromClassId: CLASS_ID, version: 0 };
    for (const body of [
      base,
      { ...base, startTime: '18:30' },
      { ...base, startTime: '25:00', timeZone: 'Europe/Paris' },
      { ...base, startsAt: '2099-01-05T09:00:00.000Z' },
    ]) {
      expect((await call(deps, 'PATCH', `/series/${SERIES_ID}`, { body })).status).toBe(422);
    }
    expect(deps.planning.updateSeries).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'not_found' }, 404, 'not_found'],
    [{ kind: 'version_conflict' }, 409, 'version_conflict'],
    [{ kind: 'class_already_started' }, 409, 'class_already_started'],
    [{ kind: 'starts_at_in_past' }, 422, 'starts_at_in_past'],
    [{ kind: 'capacity_below_confirmed', classId: CLASS_ID }, 409, 'capacity_below_confirmed'],
    [{ kind: 'room_not_found' }, 422, 'room_not_found'],
    [{ kind: 'schedule_conflict', conflicts: [CONFLICT] }, 409, 'schedule_conflict'],
  ])('PATCH /series maps %o to %i %s', async (outcome, status, code) => {
    const deps = buildStubDeps({ planning: { updateSeries: vi.fn().mockResolvedValue(outcome) } });
    const res = await call(deps, 'PATCH', `/series/${SERIES_ID}`, {
      body: { fromClassId: CLASS_ID, version: 0, title: 'New' },
    });
    expect(res.status).toBe(status);
    expect(await readJson<{ code: string }>(res)).toMatchObject({ code });
  });

  it('DELETE /series/:seriesId needs fromClassId, answers the count, 404 when unknown', async () => {
    const deleteSeries = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'deleted', count: 3 })
      .mockResolvedValueOnce({ kind: 'not_found' });
    const deps = buildStubDeps({ planning: { deleteSeries } });
    expect((await call(deps, 'DELETE', `/series/${SERIES_ID}`)).status).toBe(422);
    const res = await call(deps, 'DELETE', `/series/${SERIES_ID}?fromClassId=${CLASS_ID}`);
    expect(res.status).toBe(200);
    expect(await readJson<{ deleted: number }>(res)).toEqual({ deleted: 3 });
    expect(deleteSeries).toHaveBeenCalledWith(expect.anything(), SERIES_ID, CLASS_ID);
    expect(
      (await call(deps, 'DELETE', `/series/${SERIES_ID}?fromClassId=${CLASS_ID}`)).status,
    ).toBe(404);
  });
});

describe('conflicts on the single-class routes', () => {
  const CREATE = {
    title: 'HIIT',
    startsAt: '2099-01-05T09:00:00.000Z',
    durationMin: 45,
    capacity: 20,
    roomId: ROOM_ID,
  };

  it('POST /v1/classes answers 409 schedule_conflict with the clashing classes', async () => {
    const createClass = vi
      .fn()
      .mockResolvedValue({ kind: 'schedule_conflict', conflicts: [CONFLICT] });
    const deps = buildStubDeps({ classes: { createClass } });
    const res = await call(deps, 'POST', '', { body: CREATE });
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await readJson<{ code: string; conflicts: unknown[] }>(res)).toMatchObject({
      status: 409,
      code: 'schedule_conflict',
      conflicts: [CONFLICT],
    });
  });

  it('POST /v1/classes forwards allowConflicts and answers 201 with the class', async () => {
    const created = { id: CLASS_ID, title: 'HIIT' };
    const createClass = vi.fn().mockResolvedValue({ kind: 'created', class: created });
    const deps = buildStubDeps({ classes: { createClass } });
    const res = await call(deps, 'POST', '', { body: { ...CREATE, allowConflicts: true } });
    expect(res.status).toBe(201);
    expect(await readJson<unknown>(res)).toEqual(created);
    expect(createClass).toHaveBeenCalledWith(
      TEST_STUDIO_ID,
      { ...CREATE, allowConflicts: true },
      expect.anything(),
    );
  });

  it('POST /v1/classes answers 422 room_not_found for a room outside the studio', async () => {
    const deps = buildStubDeps({
      classes: { createClass: vi.fn().mockResolvedValue({ kind: 'room_not_found' }) },
    });
    const res = await call(deps, 'POST', '', { body: CREATE });
    expect(res.status).toBe(422);
    expect(await readJson<{ code: string }>(res)).toMatchObject({ code: 'room_not_found' });
  });

  it('PATCH /v1/classes/:id answers 409 schedule_conflict, and accepts a room-only patch', async () => {
    const updateClass = vi
      .fn()
      .mockResolvedValue({ kind: 'schedule_conflict', conflicts: [CONFLICT] });
    const deps = buildStubDeps({ classes: { updateClass } });
    const res = await call(deps, 'PATCH', `/${CLASS_ID}`, {
      body: { roomId: ROOM_ID, version: 1 },
    });
    expect(res.status).toBe(409);
    expect(await readJson<{ code: string }>(res)).toMatchObject({ code: 'schedule_conflict' });
    expect(updateClass).toHaveBeenCalledWith(
      TEST_STUDIO_ID,
      CLASS_ID,
      { roomId: ROOM_ID, version: 1 },
      expect.anything(),
    );
  });

  it('PATCH /v1/classes/:id still needs a mutable field beside allowConflicts', async () => {
    const deps = buildStubDeps();
    const res = await call(deps, 'PATCH', `/${CLASS_ID}`, {
      body: { allowConflicts: true, version: 1 },
    });
    expect(res.status).toBe(422);
    expect(deps.classes.updateClass).not.toHaveBeenCalled();
  });

  it('a version conflict keeps its own code', async () => {
    const deps = buildStubDeps({
      classes: { updateClass: vi.fn().mockResolvedValue({ kind: 'conflict' }) },
    });
    const res = await call(deps, 'PATCH', `/${CLASS_ID}`, { body: { title: 'X', version: 1 } });
    expect(res.status).toBe(409);
    expect(await readJson<{ code: string }>(res)).toMatchObject({ code: 'version_conflict' });
  });
});
