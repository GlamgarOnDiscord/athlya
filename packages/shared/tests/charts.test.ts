import { describe, expect, it } from 'vitest';

import { barPath, dayMs, linePath, niceMax, ticks, yAxisMax } from '../src/charts';

describe('niceMax', () => {
  it('rounds up to 1, 2, 2.5 or 5 × 10^n', () => {
    expect(niceMax(0.7)).toBe(1);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(1.2)).toBe(2);
    expect(niceMax(2.1)).toBe(2.5);
    expect(niceMax(420)).toBe(500);
    expect(niceMax(620)).toBe(1000);
    expect(niceMax(10_000)).toBe(10_000);
  });

  it('falls back to 1 for empty, zero, negative or NaN maxima', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-5)).toBe(1);
    expect(niceMax(Number.NaN)).toBe(1);
  });
});

describe('ticks', () => {
  it('spreads count + 1 values from 0 to max', () => {
    expect(ticks(100)).toEqual([0, 25, 50, 75, 100]);
    expect(ticks(6, 3)).toEqual([0, 2, 4, 6]);
  });
});

describe('yAxisMax', () => {
  it('uses niceMax for measurements', () => {
    expect(yAxisMax(420)).toBe(500);
  });

  it('keeps every tick of a count series on a whole number', () => {
    expect(yAxisMax(0, true)).toBe(4);
    expect(yAxisMax(3, true)).toBe(4);
    expect(yAxisMax(5, true)).toBe(8);
    expect(yAxisMax(9, true, 3)).toBe(9);
    expect(yAxisMax(Number.NaN, true)).toBe(4);
    for (const tick of ticks(yAxisMax(7, true))) expect(Number.isInteger(tick)).toBe(true);
  });
});

describe('dayMs', () => {
  it('reads a calendar day as UTC midnight', () => {
    expect(dayMs('2026-10-18')).toBe(Date.UTC(2026, 9, 18));
  });
});

describe('linePath', () => {
  it('joins the points in order', () => {
    expect(
      linePath([
        { x: 0, y: 10 },
        { x: 5, y: 2.5 },
        { x: 10, y: 0 },
      ]),
    ).toBe('M0,10 L5,2.5 L10,0');
  });

  it('draws nothing for fewer than two points', () => {
    expect(linePath([])).toBeNull();
    expect(linePath([{ x: 1, y: 1 }])).toBeNull();
  });
});

describe('barPath', () => {
  it('rounds the data end and keeps a square base', () => {
    expect(barPath(10, 20, 8, 100)).toBe('M10,100 V24 Q10,20 14,20 H14 Q18,20 18,24 V100 Z');
  });

  it('caps the corner radius on short bars', () => {
    expect(barPath(0, 98, 20, 100)).toBe('M0,100 V100 Q0,98 2,98 H18 Q20,98 20,100 V100 Z');
  });

  it('draws nothing for a zero-height or zero-width bar', () => {
    expect(barPath(0, 100, 10, 100)).toBe('');
    expect(barPath(0, 50, 0, 100)).toBe('');
  });
});
