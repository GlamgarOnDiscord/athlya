/**
 * Shared geometry and keyboard helpers for the hand-rolled SVG charts.
 *
 * The charts render plain SVG with presentation attributes only: no
 * inline `<script>`, no `style=""` and no `eval`-based chart library,
 * so the strict nonce-based CSP (`lib/csp.ts`) stays untouched.
 */

/** Fixed drawing box; the SVG scales to its container through `viewBox`. */
export const CHART_WIDTH = 640;
export const CHART_HEIGHT = 240;
export const CHART_MARGIN = { top: 16, right: 16, bottom: 32, left: 48 } as const;

export const PLOT_WIDTH = CHART_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
export const PLOT_HEIGHT = CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;

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

/** Index reached from `current` by a navigation key, or `null` for other keys. */
export function nextIndex(key: string, current: number, length: number): number | null {
  if (length === 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return Math.min(current + 1, length - 1);
    case 'ArrowLeft':
    case 'ArrowDown':
      return Math.max(current - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return length - 1;
    default:
      return null;
  }
}

/** Epoch ms of a `YYYY-MM-DD` UTC day. */
export function dayMs(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}
