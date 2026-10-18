/**
 * Pure scale and path helpers shared by the hand-rolled progression
 * charts: the web SVG charts (`apps/web/src/components/charts`) and the
 * mobile `react-native-svg` ones (`apps/mobile/components/SeriesChart`).
 *
 * Nothing here knows about the DOM, React or a drawing box: callers pass
 * pixel coordinates and get numbers or SVG path strings back.
 */

/**
 * Upper bound of the y axis rounded up to a "nice" value (1, 2, 2.5 or
 * 5 × 10^n), so gridline labels stay readable.
 */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * magnitude >= max) return step * magnitude;
  }
  return 10 * magnitude;
}

/** `count + 1` evenly spaced tick values from 0 to `max` inclusive. */
export function ticks(max: number, count = 4): number[] {
  return Array.from({ length: count + 1 }, (_, i) => (max * i) / count);
}

/**
 * Upper bound of the y axis for a series whose largest value is
 * `dataMax`. Counts (`integerScale`) round up to a multiple of `tickCount`,
 * at least `tickCount`, so every one of the `tickCount + 1` ticks is a
 * whole number; other series use `niceMax`.
 */
export function yAxisMax(dataMax: number, integerScale = false, tickCount = 4): number {
  if (integerScale) {
    const max = Number.isFinite(dataMax) && dataMax > 0 ? dataMax : 0;
    return Math.max(tickCount, Math.ceil(max / tickCount) * tickCount);
  }
  return niceMax(dataMax);
}

/** Epoch ms of a `YYYY-MM-DD` UTC day. */
export function dayMs(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

export interface ChartPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * SVG path joining `points` in order, or `null` when fewer than two
 * points leave nothing to join (a lone value is drawn as a marker).
 */
export function linePath(points: readonly ChartPoint[]): string | null {
  if (points.length < 2) return null;
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${String(p.x)},${String(p.y)}`).join(' ');
}

/**
 * Bar standing on `baseline` with its top edge at `y`: 4 px rounded
 * corners at the data end and a square base. Empty for a zero-height bar.
 */
export function barPath(x: number, y: number, width: number, baseline: number): string {
  const height = baseline - y;
  if (height <= 0 || width <= 0) return '';
  const r = Math.min(4, width / 2, height);
  return [
    `M${String(x)},${String(baseline)}`,
    `V${String(y + r)}`,
    `Q${String(x)},${String(y)} ${String(x + r)},${String(y)}`,
    `H${String(x + width - r)}`,
    `Q${String(x + width)},${String(y)} ${String(x + width)},${String(y + r)}`,
    `V${String(baseline)}`,
    'Z',
  ].join(' ');
}
