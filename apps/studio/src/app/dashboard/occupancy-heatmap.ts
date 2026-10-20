/**
 * Occupancy heatmap of the studio: fill rate of the classes held in each
 * weekday and time band over a past window, from `GET /v1/classes`.
 */
import { bookedSeats, type OverviewClass } from './dashboard-summary';

/** Start hours of the time bands; a band runs until the next start, the last until midnight. */
export const BAND_STARTS = [6, 9, 12, 15, 18, 21] as const;

export interface HeatCell {
  /** 0 = Monday … 6 = Sunday. */
  readonly weekday: number;
  readonly band: number;
  readonly classes: number;
  readonly booked: number;
  readonly capacity: number;
  /** Booked share in [0, 1], `null` when no class was held there. */
  readonly rate: number | null;
}

function bandOf(hour: number): number {
  let band = 0;
  BAND_STARTS.forEach((start, index) => {
    if (hour >= start) band = index;
  });
  return band;
}

/** Rows are time bands, columns weekdays from Monday. */
export function buildHeatmap(
  items: ReadonlyArray<OverviewClass>,
  from: Date,
  to: Date,
): HeatCell[][] {
  const sums = BAND_STARTS.map(() =>
    Array.from({ length: 7 }, () => ({ classes: 0, booked: 0, capacity: 0 })),
  );
  for (const cls of items) {
    const start = new Date(cls.startsAt);
    if (start < from || start >= to) continue;
    const slot = sums[bandOf(start.getHours())]?.[(start.getDay() + 6) % 7];
    if (slot === undefined) continue;
    slot.classes += 1;
    slot.booked += bookedSeats(cls);
    slot.capacity += cls.capacity;
  }
  return sums.map((row, band) =>
    row.map((s, weekday) => ({
      weekday,
      band,
      ...s,
      rate: s.capacity === 0 ? null : s.booked / s.capacity,
    })),
  );
}

/** Five steps: 0 to 3 for the grey (light) or volt (dark) ramp, 4 for the volt peak bucket. */
export function heatLevel(rate: number): 0 | 1 | 2 | 3 | 4 {
  if (rate >= 0.9) return 4;
  if (rate >= 0.7) return 3;
  if (rate >= 0.45) return 2;
  if (rate >= 0.2) return 1;
  return 0;
}

/** The busiest cell, ties broken by the larger capacity; `null` without any class. */
export function peakCell(grid: ReadonlyArray<ReadonlyArray<HeatCell>>): HeatCell | null {
  let best: HeatCell | null = null;
  for (const cell of grid.flat()) {
    if (cell.rate === null) continue;
    if (
      best === null ||
      best.rate === null ||
      cell.rate > best.rate ||
      (cell.rate === best.rate && cell.capacity > best.capacity)
    ) {
      best = cell;
    }
  }
  return best;
}
