/**
 * Compose the {@link ClassPlanningDeps} bundle (rooms and weekly class
 * series, issue #748) from a live `AthlyaBindings` env.
 *
 * Rooms and series run on the postgres-js write handle through the
 * adapters of `class-planning-drizzle.ts`. A created series seeds the
 * Redis remaining-seats counter of every occurrence, and a series edit
 * that changes the capacity writes back the free seats it computed
 * under the class row locks, like `createClass` / `updateClass` do for
 * a single class.
 */

import { createRedisRemainingCounter } from '@athlya/reservations';
import { expandWeeklySeries, type IsoWeekday } from '@athlya/shared/schedule';

import { createRoomsRepo, createSeriesRepo } from './class-planning-drizzle.js';
import { getOrCreateDbHttp, getOrCreateRedisForEnv, getOrCreateWriteDb } from './deps-cache.js';
import { createTenantIdempotencyDb } from './tenant-idempotency.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { ClassPlanningDeps, RoomOutcome } from '../routes/class-planning.js';
import type { AthlyaBindings } from '../types.js';
import type { TenantClaims } from '@athlya/db/client';
import type { ClassRow, RoomRow } from '@athlya/db/schema';
import type { Room } from '@athlya/shared/schemas/api';
import type { Class } from '@athlya/shared/schemas/domain';

function toTenantClaims(claims: AuthClaims): TenantClaims {
  return { userId: claims.userId, studioId: claims.studioId, role: claims.role };
}

/** Wire shape of a room row. */
export function toRoom(row: RoomRow): Room {
  return {
    id: row.id,
    studioId: row.studioId,
    name: row.name,
    capacity: row.capacity,
    createdAt: row.createdAt.toISOString(),
  } as Room;
}

/** Wire shape of a class row, room and series included. */
export function toClass(row: ClassRow): Class {
  return {
    id: row.id,
    studioId: row.studioId,
    coachId: row.coachId,
    title: row.title,
    startsAt: row.startsAt.toISOString(),
    durationMin: row.durationMin,
    capacity: row.capacity,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    roomId: row.roomId,
    seriesId: row.seriesId,
  } as Class;
}

function roomOutcome(
  outcome: { kind: 'ok'; room: RoomRow } | { kind: 'not_found' } | { kind: 'name_taken' },
): RoomOutcome {
  return outcome.kind === 'ok' ? { kind: 'ok', room: toRoom(outcome.room) } : outcome;
}

export function buildClassPlanningDeps(env: AthlyaBindings): ClassPlanningDeps {
  const rooms = (claims: AuthClaims) =>
    createRoomsRepo(getOrCreateWriteDb(env), toTenantClaims(claims));
  const series = (claims: AuthClaims) =>
    createSeriesRepo(getOrCreateWriteDb(env), toTenantClaims(claims));
  const counter = () => createRedisRemainingCounter(getOrCreateRedisForEnv(env));

  return {
    async listRooms(claims) {
      return (await rooms(claims).list()).map(toRoom);
    },
    async createRoom(claims, input) {
      return roomOutcome(await rooms(claims).create(input));
    },
    async updateRoom(claims, roomId, patch) {
      return roomOutcome(await rooms(claims).update(roomId, patch));
    },
    deleteRoom(claims, roomId) {
      return rooms(claims).remove(roomId);
    },

    async createSeries(claims, input) {
      const expansion = expandWeeklySeries({
        firstStart: new Date(input.startsAt),
        weekdays: input.recurrence.weekdays as IsoWeekday[],
        timeZone: input.timeZone,
        ...(input.recurrence.until !== undefined ? { until: input.recurrence.until } : {}),
        ...(input.recurrence.count !== undefined ? { count: input.recurrence.count } : {}),
      });
      if (!expansion.ok) return { kind: 'invalid_recurrence', reason: expansion.reason };

      const outcome = await series(claims).create(input, expansion.occurrences);
      if (outcome.kind !== 'created') return outcome;
      const seats = counter();
      await Promise.all(outcome.rows.map((row) => seats.reset(row.id, row.capacity)));
      return { kind: 'created', seriesId: outcome.seriesId, items: outcome.rows.map(toClass) };
    },

    async updateSeries(claims, seriesId, patch) {
      const outcome = await series(claims).update(seriesId, patch);
      if (outcome.kind !== 'updated') return outcome;
      if (outcome.remaining.size > 0) {
        const seats = counter();
        await Promise.all(
          [...outcome.remaining].map(([classId, free]) => seats.reset(classId, free)),
        );
      }
      return { kind: 'updated', items: outcome.rows.map(toClass) };
    },

    deleteSeries(claims, seriesId, fromClassId) {
      return series(claims).remove(seriesId, fromClassId);
    },

    idempotencyFor(claims) {
      return {
        db: createTenantIdempotencyDb(getOrCreateDbHttp(env.DB_URL), toTenantClaims(claims)),
      };
    },
  };
}
