/**
 * Shared geometry and keyboard helpers for the hand-rolled SVG charts.
 *
 * The charts render plain SVG with presentation attributes only: no
 * inline `<script>`, no `style=""` and no `eval`-based chart library,
 * so the strict nonce-based CSP (`lib/csp.ts`) stays untouched.
 *
 * The scale and path maths live in `@athlya/shared/charts`, shared with
 * the mobile charts; they are re-exported here for the web components.
 */
export { barPath, dayMs, linePath, niceMax, ticks, yAxisMax } from '@athlya/shared/charts';

/** Fixed drawing box; the SVG scales to its container through `viewBox`. */
export const CHART_WIDTH = 640;
export const CHART_HEIGHT = 240;
export const CHART_MARGIN = { top: 16, right: 16, bottom: 32, left: 48 } as const;

export const PLOT_WIDTH = CHART_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
export const PLOT_HEIGHT = CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;

/** Index reached from `current` by a navigation key, or `null` for other keys. */
export function nextIndex(key: string, current: number, length: number): number | null {
  if (length === 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return Math.min(current + 1, length - 1);
    case 'ArrowLeft':
    case 'ArrowUp':
      return Math.max(current - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return length - 1;
    default:
      return null;
  }
}
