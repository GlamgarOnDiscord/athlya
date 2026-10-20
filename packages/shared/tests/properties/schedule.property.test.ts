/**
 * Properties of the planning helpers (issue #748).
 *
 *   - Overlap is symmetric, half-open (touching intervals never clash)
 *     and agrees with a minute-by-minute definition.
 *   - A conflict is reported exactly when the intervals overlap and a
 *     room or a coach is shared, with the matching reasons.
 *   - A weekly expansion is strictly increasing, lands only on chosen
 *     weekdays at the first start's wall-clock time in the series time
 *     zone, honours `count` / `until` and never exceeds the cap.
 */

import { fc, it } from '@fast-check/vitest';
import { describe, expect } from 'vitest';

import {
  MAX_SERIES_OCCURRENCES,
  conflictReasons,
  expandWeeklySeries,
  intervalsOverlap,
  toZonedParts,
  type IsoWeekday,
} from '../../src/schedule.js';

const ZONES = ['UTC', 'Europe/Paris', 'America/New_York', 'Australia/Sydney', 'Asia/Kolkata'];

/** Minutes since an arbitrary origin, up to two weeks. */
const minuteArb = fc.integer({ min: 0, max: 14 * 24 * 60 });
const durationArb = fc.integer({ min: 5, max: 480 });
const resourceArb = fc.option(fc.constantFrom('r1', 'r2'), { nil: null });
const coachArb = fc.option(fc.constantFrom('c1', 'c2'), { nil: null });

const slotArb = fc.record({
  start: minuteArb,
  durationMin: durationArb,
  roomId: resourceArb,
  coachId: coachArb,
});

const ORIGIN = Date.UTC(2030, 0, 1);
const toSlot = (s: {
  start: number;
  durationMin: number;
  roomId: string | null;
  coachId: string | null;
}) => ({
  startsAt: new Date(ORIGIN + s.start * 60_000),
  durationMin: s.durationMin,
  roomId: s.roomId,
  coachId: s.coachId,
});

describe('intervalsOverlap', () => {
  it.prop([minuteArb, durationArb, minuteArb, durationArb])(
    'is symmetric and matches the minute-by-minute definition',
    (a, da, b, db) => {
      const overlap = intervalsOverlap(a, a + da, b, b + db);
      expect(overlap).toBe(intervalsOverlap(b, b + db, a, a + da));
      const shared = Math.max(a, b) < Math.min(a + da, b + db);
      expect(overlap).toBe(shared);
    },
  );

  it.prop([minuteArb, durationArb, durationArb])(
    'never reports back-to-back intervals',
    (a, da, db) => {
      expect(intervalsOverlap(a, a + da, a + da, a + da + db)).toBe(false);
    },
  );
});

describe('conflictReasons', () => {
  it.prop([slotArb, slotArb])(
    'reports a clash exactly on overlap plus a shared resource',
    (x, y) => {
      const a = toSlot(x);
      const b = toSlot(y);
      const overlap = intervalsOverlap(
        x.start,
        x.start + x.durationMin,
        y.start,
        y.start + y.durationMin,
      );
      const expected = overlap
        ? [
            ...(x.roomId !== null && x.roomId === y.roomId ? ['room'] : []),
            ...(x.coachId !== null && x.coachId === y.coachId ? ['coach'] : []),
          ]
        : [];
      expect(conflictReasons(a, b)).toEqual(expected);
      expect(conflictReasons(b, a)).toEqual(expected);
    },
  );
});

const weekdaysArb = fc
  .uniqueArray(fc.integer({ min: 1, max: 7 }), { minLength: 1, maxLength: 7 })
  .map((days) => days as IsoWeekday[]);

const firstStartArb = fc
  .integer({ min: Date.UTC(2027, 0, 1), max: Date.UTC(2029, 11, 31) })
  .map((ms) => new Date(Math.floor(ms / 60_000) * 60_000));

function isoWeekdayOf(date: Date, timeZone: string): number {
  const p = toZonedParts(date, timeZone);
  return ((new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() + 6) % 7) + 1;
}

describe('expandWeeklySeries', () => {
  it.prop([
    firstStartArb,
    weekdaysArb,
    fc.integer({ min: 2, max: MAX_SERIES_OCCURRENCES }),
    fc.constantFrom(...ZONES),
  ])(
    'with a count: exactly that many, increasing, on chosen weekdays, at the first wall-clock time',
    (firstStart, weekdays, count, timeZone) => {
      const result = expandWeeklySeries({ firstStart, weekdays, count, timeZone });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { occurrences } = result;
      expect(occurrences).toHaveLength(count);
      const wall = toZonedParts(firstStart, timeZone);
      occurrences.forEach((occurrence, i) => {
        if (i > 0) expect(occurrence.getTime()).toBeGreaterThan(occurrences[i - 1]!.getTime());
        expect(weekdays).toContain(isoWeekdayOf(occurrence, timeZone));
        const parts = toZonedParts(occurrence, timeZone);
        // A wall-clock time skipped by a DST jump lands one hour later.
        const minutes = parts.hour * 60 + parts.minute - (wall.hour * 60 + wall.minute);
        expect([0, 60]).toContain(minutes);
      });
      expect(occurrences[0]!.getTime()).toBeGreaterThanOrEqual(firstStart.getTime() - 60 * 60_000);
    },
  );

  it.prop([
    firstStartArb,
    weekdaysArb,
    fc.integer({ min: 0, max: 120 }),
    fc.constantFrom(...ZONES),
  ])(
    'with until: every chosen day up to it, none after, or a refusal past the cap',
    (firstStart, weekdays, spanDays, timeZone) => {
      const wall = toZonedParts(firstStart, timeZone);
      const untilMs = Date.UTC(wall.year, wall.month - 1, wall.day + spanDays);
      const until = new Date(untilMs).toISOString().slice(0, 10);
      const result = expandWeeklySeries({ firstStart, weekdays, until, timeZone });

      let expected = 0;
      for (let d = 0; d <= spanDays; d++) {
        const day = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + d));
        if (weekdays.includes(((day.getUTCDay() + 6) % 7) + 1)) expected++;
      }
      if (expected === 0) {
        expect(result).toEqual({ ok: false, reason: 'no_occurrences' });
      } else if (expected > MAX_SERIES_OCCURRENCES) {
        expect(result).toEqual({ ok: false, reason: 'too_many_occurrences' });
      } else {
        expect(result.ok && result.occurrences.length).toBe(expected);
        if (result.ok) {
          const last = toZonedParts(result.occurrences.at(-1)!, timeZone);
          expect(Date.UTC(last.year, last.month - 1, last.day)).toBeLessThanOrEqual(untilMs);
        }
      }
    },
  );
});
