/**
 * Unit tests for the planning calendar maths. Pinned to Europe/Paris so
 * the weeks of 29 March and 25 October 2026 cross a real DST change.
 */
import { afterAll, describe, expect, it } from 'vitest';

import {
  blockDensity,
  blockGeometry,
  buildMonthGrid,
  buildWeekDays,
  fromDayKey,
  groupByDay,
  hasStarted,
  hourBounds,
  layoutDay,
  listRange,
  resolveView,
  seatsLeftKey,
  shiftAnchor,
  toDayKey,
  visibleRange,
} from './planning-grid';

const previousTz = process.env['TZ'];
process.env['TZ'] = 'Europe/Paris';

afterAll(() => {
  if (previousTz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = previousTz;
});

function item(startsAt: string, durationMin: number, id = startsAt) {
  return { id, startsAt, durationMin };
}

describe('buildWeekDays', () => {
  it('starts on Monday and keeps seven local midnights across the October DST change', () => {
    const days = buildWeekDays(fromDayKey('2026-10-21'));
    expect(days.map(toDayKey)).toEqual([
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
    ]);
    for (const day of days) {
      expect(day.getHours()).toBe(0);
      expect(day.getMinutes()).toBe(0);
    }
  });

  it('treats a Sunday as the last day of its week', () => {
    expect(toDayKey(buildWeekDays(fromDayKey('2026-03-29'))[0] ?? new Date(0))).toBe('2026-03-23');
  });
});

describe('buildMonthGrid', () => {
  it('covers March 2026 with six Monday-first weeks across the spring DST change', () => {
    const weeks = buildMonthGrid(fromDayKey('2026-03-15'));
    expect(weeks).toHaveLength(6);
    expect(weeks[0]?.[0]?.key).toBe('2026-02-23');
    expect(weeks[5]?.[6]?.key).toBe('2026-04-05');
    const cells = weeks.flat();
    expect(new Set(cells.map((c) => c.key)).size).toBe(42);
    expect(cells.every((c) => c.date.getHours() === 0)).toBe(true);
    expect(cells.filter((c) => c.inMonth)).toHaveLength(31);
    expect(cells.find((c) => c.key === '2026-02-28')?.inMonth).toBe(false);
  });

  it('uses exactly four weeks when the month starts on Monday and ends on Sunday', () => {
    const weeks = buildMonthGrid(fromDayKey('2027-02-10'));
    expect(weeks).toHaveLength(4);
    expect(weeks.flat().every((c) => c.inMonth)).toBe(true);
  });
});

describe('visibleRange', () => {
  it('spans local midnights of a week, 25 hours longer on the DST Sunday', () => {
    const { from, to } = visibleRange('week', fromDayKey('2026-10-21'));
    expect(from.toISOString()).toBe('2026-10-18T22:00:00.000Z');
    expect(to.toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });

  it('spans the whole month grid', () => {
    const { from, to } = visibleRange('month', fromDayKey('2026-03-15'));
    expect(toDayKey(from)).toBe('2026-02-23');
    expect(toDayKey(to)).toBe('2026-04-06');
    expect(to.getHours()).toBe(0);
  });
});

describe('shiftAnchor', () => {
  it('moves by one week or one calendar month', () => {
    const anchor = fromDayKey('2026-01-31');
    expect(toDayKey(shiftAnchor('week', anchor, 1))).toBe('2026-02-07');
    expect(toDayKey(shiftAnchor('week', anchor, -1))).toBe('2026-01-24');
    expect(toDayKey(shiftAnchor('month', anchor, 1))).toBe('2026-02-01');
    expect(toDayKey(shiftAnchor('month', anchor, -1))).toBe('2025-12-01');
  });
});

describe('groupByDay', () => {
  it('groups by local start day, sorted by time', () => {
    const late = item('2026-10-20T22:30:00.000Z', 60, 'late');
    const early = item('2026-10-20T05:00:00.000Z', 60, 'early');
    const groups = groupByDay([late, early]);
    expect(groups.get('2026-10-20')?.map((c) => c.id)).toEqual(['early']);
    expect(groups.get('2026-10-21')?.map((c) => c.id)).toEqual(['late']);
  });
});

describe('layoutDay', () => {
  it('uses wall-clock minutes on the DST Sunday', () => {
    const [block] = layoutDay([item('2026-10-25T17:30:00.000Z', 60)]);
    expect(block?.startMin).toBe(18 * 60 + 30);
    expect(block?.endMin).toBe(19 * 60 + 30);
  });

  it('puts overlapping classes side by side and a later one back to full width', () => {
    const blocks = layoutDay([
      item('2026-10-23T16:00:00.000Z', 60, 'a'),
      item('2026-10-23T16:30:00.000Z', 60, 'b'),
      item('2026-10-23T19:00:00.000Z', 45, 'c'),
    ]);
    const byId = Object.fromEntries(blocks.map((b) => [b.item.id, b]));
    expect([byId['a']?.lane, byId['a']?.lanes]).toEqual([0, 2]);
    expect([byId['b']?.lane, byId['b']?.lanes]).toEqual([1, 2]);
    expect([byId['c']?.lane, byId['c']?.lanes]).toEqual([0, 1]);
  });

  it('reuses a freed lane inside one cluster', () => {
    const blocks = layoutDay([
      item('2026-10-23T08:00:00.000Z', 120, 'long'),
      item('2026-10-23T08:00:00.000Z', 30, 'short'),
      item('2026-10-23T08:45:00.000Z', 30, 'next'),
    ]);
    const byId = Object.fromEntries(blocks.map((b) => [b.item.id, b]));
    expect(byId['long']?.lane).toBe(0);
    expect(byId['short']?.lane).toBe(1);
    expect(byId['next']?.lane).toBe(1);
    expect(blocks.every((b) => b.lanes === 2)).toBe(true);
  });

  it('clips a class running past midnight to the end of its day', () => {
    const [block] = layoutDay([item('2026-10-23T21:30:00.000Z', 90)]);
    expect(block?.endMin).toBe(24 * 60);
  });
});

describe('hourBounds and blockGeometry', () => {
  it('keeps the default day and widens it to fit early or late classes', () => {
    expect(hourBounds([])).toEqual({ startHour: 6, endHour: 22 });
    const blocks = layoutDay([
      item('2026-10-23T03:30:00.000Z', 30),
      item('2026-10-23T20:00:00.000Z', 60),
    ]);
    expect(hourBounds(blocks)).toEqual({ startHour: 5, endHour: 23 });
  });

  it('positions a block in percent of the day column', () => {
    const blocks = layoutDay([
      item('2026-10-23T05:00:00.000Z', 120, 'a'),
      item('2026-10-23T06:00:00.000Z', 60, 'b'),
    ]);
    const second = blocks.find((b) => b.item.id === 'b');
    if (second === undefined) throw new Error('block missing');
    expect(blockGeometry(second, { startHour: 6, endHour: 22 })).toEqual({
      top: 12.5,
      height: 6.25,
      left: 50,
      width: 50,
    });
  });
});

describe('day agenda helpers', () => {
  it('steps one day and loads the whole week of the day', () => {
    const anchor = fromDayKey('2026-10-25');
    expect(toDayKey(shiftAnchor('day', anchor, 1))).toBe('2026-10-26');
    expect(toDayKey(shiftAnchor('day', anchor, -1))).toBe('2026-10-24');
    const { from, to } = visibleRange('day', anchor);
    expect(toDayKey(from)).toBe('2026-10-19');
    expect(toDayKey(to)).toBe('2026-10-26');
  });

  it('shows the day agenda on a narrow screen and the week grid in place of it on a wide one', () => {
    expect(resolveView('week', false)).toBe('day');
    expect(resolveView('month', false)).toBe('day');
    expect(resolveView('day', false)).toBe('day');
    expect(resolveView('day', true)).toBe('week');
    expect(resolveView('week', true)).toBe('week');
    expect(resolveView('month', true)).toBe('month');
  });
});

describe('blockDensity', () => {
  const density = (durationMin: number) => {
    const [block] = layoutDay([item('2026-10-23T08:00:00.000Z', durationMin)]);
    if (block === undefined) throw new Error('block missing');
    return blockDensity(block);
  };

  it('keeps three lines from 60 minutes, two from 45 and one below', () => {
    expect(density(90)).toBe('full');
    expect(density(60)).toBe('full');
    expect(density(59)).toBe('medium');
    expect(density(45)).toBe('medium');
    expect(density(44)).toBe('compact');
    expect(density(30)).toBe('compact');
    expect(density(5)).toBe('compact');
  });

  it('uses the clipped length of a class running past midnight', () => {
    const [block] = layoutDay([item('2026-10-23T21:30:00.000Z', 90)]);
    if (block === undefined) throw new Error('block missing');
    expect(blockDensity(block)).toBe('compact');
  });
});

describe('listRange', () => {
  it('covers the calendar month of the anchor, without spilling weeks', () => {
    const { from, to } = listRange(new Date(2026, 9, 20));
    expect(toDayKey(from)).toBe('2026-10-01');
    expect(toDayKey(to)).toBe('2026-11-01');
  });
});

describe('hasStarted', () => {
  const now = new Date('2026-10-20T10:00:00.000Z');

  it('is true from the start time on and false before it', () => {
    expect(hasStarted('2026-10-20T09:59:00.000Z', now)).toBe(true);
    expect(hasStarted('2026-10-20T10:00:00.000Z', now)).toBe(true);
    expect(hasStarted('2026-10-20T10:01:00.000Z', now)).toBe(false);
  });
});

describe('seatsLeftKey', () => {
  it('uses the singular for one seat and the plural above it', () => {
    expect(seatsLeftKey('fr', 1)).toBe('studio.classes.planning.seatLeft');
    expect(seatsLeftKey('fr', 2)).toBe('studio.classes.planning.seatsLeft');
    expect(seatsLeftKey('en', 1)).toBe('studio.classes.planning.seatLeft');
    expect(seatsLeftKey('en', 5)).toBe('studio.classes.planning.seatsLeft');
  });

  it('follows each locale for zero: singular in French, plural in English', () => {
    expect(seatsLeftKey('fr', 0)).toBe('studio.classes.planning.seatLeft');
    expect(seatsLeftKey('en', 0)).toBe('studio.classes.planning.seatsLeft');
  });
});
