import { describe, expect, it } from 'vitest';

import { buildHeatmap, heatLevel, peakCell } from './occupancy-heatmap';

import type { OverviewClass } from './dashboard-summary';

function cls(day: number, hour: number, capacity: number, remaining: number): OverviewClass {
  return {
    id: `${String(day)}-${String(hour)}`,
    title: 'HIIT 45',
    startsAt: new Date(2026, 9, day, hour, 30).toISOString(),
    durationMin: 45,
    capacity,
    remaining,
  };
}

const FROM = new Date(2026, 9, 1);
const TO = new Date(2026, 10, 1);

describe('buildHeatmap', () => {
  it('sums classes by weekday and time band, Monday first', () => {
    // 15 and 22 October 2026 are Thursdays, 18:30 falls in the 18 h band.
    const grid = buildHeatmap([cls(15, 18, 10, 1), cls(22, 18, 10, 3)], FROM, TO);
    const thursdayEvening = grid[4]?.[3];
    expect(thursdayEvening).toMatchObject({ classes: 2, booked: 16, capacity: 20, rate: 0.8 });
    expect(grid[0]?.[0]?.rate).toBeNull();
  });

  it('puts early classes in the first band and skips classes outside the window', () => {
    const grid = buildHeatmap([cls(19, 5, 10, 0), cls(1, 9, 10, 0), cls(31, 9, 10, 0)], FROM, TO);
    expect(grid[0]?.[0]?.classes).toBe(1);
    expect(grid[1]?.[3]?.classes).toBe(1);
    expect(grid[1]?.[5]?.classes).toBe(1);
    expect(
      buildHeatmap([cls(15, 9, 10, 0)], TO, TO)
        .flat()
        .every((c) => c.rate === null),
    ).toBe(true);
  });
});

describe('heatLevel', () => {
  it('maps fill rates to five steps with a peak bucket from 90 %', () => {
    expect([0, 0.2, 0.45, 0.7, 0.89, 0.9, 1].map(heatLevel)).toEqual([0, 1, 2, 3, 3, 4, 4]);
  });
});

describe('peakCell', () => {
  it('returns the busiest cell, the larger one on a tie, and null without data', () => {
    const grid = buildHeatmap(
      [cls(13, 9, 10, 0), cls(16, 18, 20, 0), cls(14, 12, 10, 5)],
      FROM,
      TO,
    );
    expect(peakCell(grid)).toMatchObject({ weekday: 4, band: 4, capacity: 20 });
    expect(peakCell(buildHeatmap([], FROM, TO))).toBeNull();
  });
});
