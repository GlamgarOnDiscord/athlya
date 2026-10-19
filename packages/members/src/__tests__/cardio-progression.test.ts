/**
 * Unit + property tests for `@athlya/members/cardio-progression` (issue #683).
 */

import { CardioProgressionResponseSchema } from '@athlya/shared/schemas/api';
import { CARDIO_MACHINES } from '@athlya/shared/schemas/domain';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import {
  cardioBucketStart,
  computeCardioProgression,
  getCardioProgression,
  type CardioProgressionRepo,
  type CardioSessionRow,
} from '../cardio-progression.js';
import { PROGRESSION_SESSION_LIMIT, progressionWindowBounds } from '../progression.js';
import { MembersError } from '../service.js';

import type { CardioMetrics } from '@athlya/shared/schemas/domain';

const USER_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ab';
/** Thursday 2026-10-15, 14:30 UTC. */
const NOW = Date.parse('2026-10-15T14:30:00.000Z');

/** `cardio` is typed loosely so invalid stored payloads can be fed in. */
function row(
  startedAt: string,
  cardio: CardioMetrics | Record<string, unknown> | null | undefined,
): CardioSessionRow {
  return { startedAt, cardio };
}

const week = (rows: readonly CardioSessionRow[]) =>
  computeCardioProgression(rows, { windowDays: 30, bucket: 'week', now: NOW });

describe('cardioBucketStart', () => {
  it('starts a day at UTC midnight and a week on Monday (UTC)', () => {
    const sunday = Date.parse('2026-10-11T23:59:59.999Z');
    expect(new Date(cardioBucketStart('day', sunday)).toISOString()).toBe(
      '2026-10-11T00:00:00.000Z',
    );
    expect(new Date(cardioBucketStart('week', sunday)).toISOString()).toBe(
      '2026-10-05T00:00:00.000Z',
    );
    expect(
      new Date(cardioBucketStart('week', Date.parse('2026-10-12T00:00:00.000Z'))).toISOString(),
    ).toBe('2026-10-12T00:00:00.000Z');
  });
});

describe('computeCardioProgression', () => {
  it('returns zero totals and no machine for an empty window', () => {
    const result = week([]);
    expect(result).toEqual({
      windowDays: 30,
      from: '2026-09-16T00:00:00.000Z',
      to: '2026-10-16T00:00:00.000Z',
      bucket: 'week',
      totals: { sessions: 0, durationSec: 0, distanceM: 0, energyKcal: 0 },
      machines: [],
      truncated: false,
      skippedSessions: 0,
    });
    expect(CardioProgressionResponseSchema.parse(result)).toEqual(result);
  });

  it('ignores sessions without cardio and counts invalid rows as skipped', () => {
    const result = week([
      row('2026-10-14T08:00:00.000Z', null),
      row('2026-10-14T09:00:00.000Z', undefined),
      row('2026-10-14T10:00:00.000Z', { machine: 'rower', distanceM: -5 }),
      row('2026-10-14T11:00:00.000Z', { machine: 'rower', unknownField: 1 }),
      row('not a date', { machine: 'rower', distanceM: 1_000 }),
      row('2026-10-14T12:00:00.000Z', { machine: 'rower', distanceM: 2_000 }),
    ]);
    expect(result.skippedSessions).toBe(3);
    expect(result.totals).toEqual({ sessions: 1, durationSec: 0, distanceM: 2_000, energyKcal: 0 });
    expect(result.machines.map((m) => m.machine)).toEqual(['rower']);
  });

  it('keeps only sessions in [from, to)', () => {
    const result = week([
      row('2026-09-15T23:59:59.999Z', { machine: 'treadmill', distanceM: 1 }),
      row('2026-09-16T00:00:00.000Z', { machine: 'treadmill', distanceM: 10 }),
      row('2026-10-15T23:59:59.999Z', { machine: 'treadmill', distanceM: 100 }),
      row('2026-10-16T00:00:00.000Z', { machine: 'treadmill', distanceM: 1_000 }),
    ]);
    expect(result.totals.sessions).toBe(2);
    expect(result.totals.distanceM).toBe(110);
  });

  it('splits machines in a stable order with an unspecified bucket last', () => {
    const result = week([
      row('2026-10-14T08:00:00.000Z', { distanceM: 500 }),
      row('2026-10-13T08:00:00.000Z', { machine: 'rower', distanceM: 2_000 }),
      row('2026-10-12T08:00:00.000Z', { machine: 'indoorBike', distanceM: 20_000 }),
      row('2026-10-10T08:00:00.000Z', { machine: 'indoorBike', distanceM: 15_000 }),
    ]);
    expect(result.machines.map((m) => [m.machine, m.sessionCount, m.totals.distanceM])).toEqual([
      ['indoorBike', 2, 35_000],
      ['rower', 1, 2_000],
      ['unspecified', 1, 500],
    ]);
    expect(result.totals).toEqual({
      sessions: 4,
      durationSec: 0,
      distanceM: 37_500,
      energyKcal: 0,
    });
  });

  it('zero-fills ISO weeks and splits on the Sunday/Monday UTC boundary', () => {
    const result = week([
      row('2026-10-11T23:59:59.000Z', { machine: 'indoorBike', distanceM: 1_000 }),
      row('2026-10-12T00:00:00.000Z', { machine: 'indoorBike', distanceM: 2_000 }),
    ]);
    const bike = result.machines[0];
    expect(bike?.series.map((b) => [b.periodStart, b.sessions, b.distanceM])).toEqual([
      ['2026-09-14', 0, 0],
      ['2026-09-21', 0, 0],
      ['2026-09-28', 0, 0],
      ['2026-10-05', 1, 1_000],
      ['2026-10-12', 1, 2_000],
    ]);
    expect(bike?.series[0]).toEqual({
      periodStart: '2026-09-14',
      sessions: 0,
      durationSec: 0,
      distanceM: 0,
      energyKcal: 0,
      avgPowerW: null,
      avgHeartRateBpm: null,
    });
  });

  it('zero-fills one bucket per UTC day with the day bucket', () => {
    const result = computeCardioProgression(
      [row('2026-10-15T06:00:00.000Z', { machine: 'treadmill', durationSec: 1_200 })],
      { windowDays: 30, bucket: 'day', now: NOW },
    );
    const series = result.machines[0]?.series ?? [];
    expect(series).toHaveLength(30);
    expect(series[0]?.periodStart).toBe('2026-09-16');
    expect(series.at(-1)).toMatchObject({ periodStart: '2026-10-15', durationSec: 1_200 });
    expect(result.bucket).toBe('day');
  });

  it('sums duration, distance and energy and weights averages by moving time', () => {
    const result = week([
      row('2026-10-13T08:00:00.000Z', {
        machine: 'indoorBike',
        durationSec: 3_600,
        distanceM: 30_000,
        energyKcal: 700,
        avgPowerW: 200,
        avgHeartRateBpm: 150,
      }),
      row('2026-10-14T08:00:00.000Z', {
        machine: 'indoorBike',
        durationSec: 900,
        distanceM: 6_000,
        energyKcal: 120,
        avgPowerW: 100,
      }),
    ]);
    expect(result.machines[0]?.series.at(-1)).toEqual({
      periodStart: '2026-10-12',
      sessions: 2,
      durationSec: 4_500,
      distanceM: 36_000,
      energyKcal: 820,
      avgPowerW: 180,
      avgHeartRateBpm: 150,
    });
  });

  it('falls back to the plain mean when no session reporting the metric has a duration', () => {
    const result = week([
      row('2026-10-13T08:00:00.000Z', { machine: 'rower', avgPowerW: 101 }),
      row('2026-10-14T08:00:00.000Z', { machine: 'rower', avgPowerW: 150 }),
    ]);
    expect(result.machines[0]?.series.at(-1)?.avgPowerW).toBe(125.5);
  });

  it('lists one point per session, ascending, with null for unreported metrics', () => {
    const result = week([
      row('2026-10-14T08:00:00+02:00', { machine: 'treadmill', avgSpeedKmh: 10.5 }),
      row('2026-10-01T18:00:00.000Z', {
        machine: 'treadmill',
        durationSec: 1_800,
        distanceM: 5_000,
        avgHeartRateBpm: 160,
      }),
    ]);
    expect(result.machines[0]?.points).toEqual([
      {
        startedAt: '2026-10-01T18:00:00.000Z',
        durationSec: 1_800,
        distanceM: 5_000,
        avgPowerW: null,
        avgSpeedKmh: null,
        avgHeartRateBpm: 160,
      },
      {
        startedAt: '2026-10-14T06:00:00.000Z',
        durationSec: null,
        distanceM: null,
        avgPowerW: null,
        avgSpeedKmh: 10.5,
        avgHeartRateBpm: null,
      },
    ]);
  });

  it('always produces a schema-valid, self-consistent response (property)', () => {
    const { from, to } = progressionWindowBounds(90, NOW);
    const cardioArb = fc.record(
      {
        machine: fc.constantFrom(...CARDIO_MACHINES),
        durationSec: fc.integer({ min: 0, max: 86_400 }),
        distanceM: fc.integer({ min: 0, max: 1_000_000 }),
        energyKcal: fc.integer({ min: 0, max: 20_000 }),
        avgPowerW: fc.integer({ min: 0, max: 4_000 }),
        avgHeartRateBpm: fc.integer({ min: 20, max: 250 }),
        avgSpeedKmh: fc.double({ min: 0, max: 150, noNaN: true }),
      },
      { requiredKeys: [] },
    );
    const rowArb = fc.record({
      startedAt: fc
        .integer({ min: from.getTime() - 10 * 86_400_000, max: to.getTime() + 86_400_000 })
        .map((ms) => new Date(ms).toISOString()),
      cardio: cardioArb,
    });
    fc.assert(
      fc.property(
        fc.array(rowArb, { maxLength: 40 }),
        fc.constantFrom('day' as const, 'week' as const),
        (rows, bucket) => {
          const result = computeCardioProgression(rows, { windowDays: 90, bucket, now: NOW });
          CardioProgressionResponseSchema.parse(result);
          const perMachine = result.machines.reduce((n, m) => n + m.sessionCount, 0);
          expect(perMachine).toBe(result.totals.sessions);
          for (const machine of result.machines) {
            expect(machine.series.reduce((n, b) => n + b.sessions, 0)).toBe(machine.sessionCount);
            expect(machine.series.reduce((n, b) => n + b.distanceM, 0)).toBe(
              machine.totals.distanceM,
            );
            expect(machine.points).toHaveLength(machine.sessionCount);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('getCardioProgression', () => {
  function repoReturning(rows: readonly CardioSessionRow[]) {
    const listCardioInWindow = vi.fn<CardioProgressionRepo['listCardioInWindow']>(() =>
      Promise.resolve(rows),
    );
    return { repo: { listCardioInWindow }, listCardioInWindow };
  }

  it('rejects a window other than 30 / 90 / 365', async () => {
    const { repo, listCardioInWindow } = repoReturning([]);
    await expect(getCardioProgression(USER_ID, 7, 'week', { repo })).rejects.toBeInstanceOf(
      MembersError,
    );
    expect(listCardioInWindow).not.toHaveBeenCalled();
  });

  it('rejects a bucket other than day / week', async () => {
    const { repo, listCardioInWindow } = repoReturning([]);
    await expect(getCardioProgression(USER_ID, 30, 'month', { repo })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(listCardioInWindow).not.toHaveBeenCalled();
  });

  it('reads the window bounds with one row over the limit', async () => {
    const { repo, listCardioInWindow } = repoReturning([]);
    await getCardioProgression(USER_ID, 90, 'week', { repo, now: () => NOW });
    expect(listCardioInWindow).toHaveBeenCalledWith(USER_ID, {
      ...progressionWindowBounds(90, NOW),
      limit: PROGRESSION_SESSION_LIMIT + 1,
    });
  });

  it('flags truncation and drops the extra row', async () => {
    const rows = Array.from({ length: PROGRESSION_SESSION_LIMIT + 1 }, (_, i) =>
      row(new Date(NOW - i * 60_000).toISOString(), { machine: 'rower', distanceM: 1 }),
    );
    const { repo } = repoReturning(rows);
    const result = await getCardioProgression(USER_ID, 30, 'week', { repo, now: () => NOW });
    expect(result.truncated).toBe(true);
    expect(result.totals.sessions).toBe(PROGRESSION_SESSION_LIMIT);
  });
});
