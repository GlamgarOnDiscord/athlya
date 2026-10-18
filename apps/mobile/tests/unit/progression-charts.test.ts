import { describe, expect, it } from 'vitest';

import { radioA11yProps } from '../../components/ui/a11y';
import { formatNumber, formatUtcDay } from '../../features/format';
import {
  CHART_HEIGHT,
  CHART_MARGIN,
  frequencySeries,
  frequencySummary,
  layoutChart,
  lineSummary,
  MARKER_LIMIT,
  oneRepMaxSeries,
  volumeSeries,
  windowBounds,
  type SeriesPoint,
  type SummaryFormat,
} from '../../features/progression/progression-charts';

import type { ExerciseProgression } from '@athlya/shared/schemas/api';

const SQUAT: ExerciseProgression = {
  key: 'squat',
  name: 'Squat',
  sessionCount: 3,
  totalVolumeKg: 1750,
  bestEstimatedOneRepMaxKg: 110,
  points: [
    { date: '2026-10-01', volumeKg: 500, estimatedOneRepMaxKg: 100 },
    { date: '2026-10-05', volumeKg: 450, estimatedOneRepMaxKg: null },
    { date: '2026-10-08', volumeKg: 800, estimatedOneRepMaxKg: 110 },
  ],
};

const FORMAT: SummaryFormat = {
  day: (date) => formatUtcDay(date, 'en'),
  number: (value) => formatNumber(value, 'en'),
};

function point(key: string, x: number, value: number): SeriesPoint {
  return { key, date: key, x, value };
}

describe('series', () => {
  it('plots daily volume at the middle of each UTC day', () => {
    const series = volumeSeries(SQUAT);
    expect(series.map((p) => p.value)).toEqual([500, 450, 800]);
    expect(series[0]).toEqual({
      key: '2026-10-01',
      date: '2026-10-01',
      x: Date.UTC(2026, 9, 1, 12),
      value: 500,
    });
  });

  it('leaves out the days without an estimated 1RM', () => {
    expect(oneRepMaxSeries(SQUAT).map((p) => [p.date, p.value])).toEqual([
      ['2026-10-01', 100],
      ['2026-10-08', 110],
    ]);
  });

  it('keeps every week, including the zero-filled ones', () => {
    expect(
      frequencySeries([
        { weekStart: '2026-09-28', sessions: 0 },
        { weekStart: '2026-10-05', sessions: 3 },
      ]).map((p) => [p.date, p.x, p.value]),
    ).toEqual([
      ['2026-09-28', Date.UTC(2026, 8, 28), 0],
      ['2026-10-05', Date.UTC(2026, 9, 5), 3],
    ]);
  });

  it('labels the window with its first and last UTC day', () => {
    expect(windowBounds('2026-07-21T00:00:00.000Z', '2026-10-19T00:00:00.000Z')).toEqual([
      '2026-07-21',
      '2026-10-18',
    ]);
    expect(windowBounds('2026-07-21T02:00:00+02:00', '2026-10-19T02:00:00+02:00')).toEqual([
      '2026-07-21',
      '2026-10-18',
    ]);
  });
});

describe('layoutChart', () => {
  const plotBottom = CHART_HEIGHT - CHART_MARGIN.bottom;
  const plotTop = CHART_MARGIN.top;

  it('scales a line chart on the window domain with a nice y axis', () => {
    const layout = layoutChart({
      kind: 'line',
      points: [point('a', 25, 100), point('b', 75, 420)],
      width: 300,
      xDomain: [0, 100],
    });
    expect(layout.yMax).toBe(500);
    expect(layout.ticks.map((tick) => tick.value)).toEqual([0, 125, 250, 375, 500]);
    expect(layout.ticks[0]?.y).toBe(plotBottom);
    expect(layout.ticks[4]?.y).toBe(plotTop);

    const plotWidth = 300 - CHART_MARGIN.left - CHART_MARGIN.right;
    expect(layout.marks.map((mark) => mark.x)).toEqual([
      CHART_MARGIN.left + plotWidth * 0.25,
      CHART_MARGIN.left + plotWidth * 0.75,
    ]);
    expect(layout.marks[1]?.y).toBeCloseTo(plotBottom - (420 / 500) * (plotBottom - plotTop));
    expect(layout.line).toMatch(/^M[\d.]+,[\d.]+ L[\d.]+,[\d.]+$/u);
    expect(layout.bars).toEqual([]);
    expect(layout.showMarkers).toBe(true);
  });

  it('draws a lone value as a marker, centred without a domain', () => {
    const layout = layoutChart({ kind: 'line', points: [point('a', 5, 10)], width: 200 });
    expect(layout.line).toBeNull();
    expect(layout.showMarkers).toBe(true);
    expect(layout.marks[0]?.x).toBe(CHART_MARGIN.left + (200 - 56) / 2);
  });

  it('drops the markers on long series', () => {
    const points = Array.from({ length: MARKER_LIMIT + 1 }, (_, i) => point(String(i), i, i));
    expect(layoutChart({ kind: 'line', points, width: 320 }).showMarkers).toBe(false);
  });

  it('lays bars out in equal bands with whole-number ticks', () => {
    const layout = layoutChart({
      kind: 'bar',
      points: [point('w1', 0, 0), point('w2', 1, 3), point('w3', 2, 5)],
      width: 356,
      integerScale: true,
    });
    expect(layout.yMax).toBe(8);
    expect(layout.ticks.map((tick) => tick.value)).toEqual([0, 2, 4, 6, 8]);
    const band = (356 - CHART_MARGIN.left - CHART_MARGIN.right) / 3;
    expect(layout.marks.map((mark) => mark.x)).toEqual([
      CHART_MARGIN.left + band * 0.5,
      CHART_MARGIN.left + band * 1.5,
      CHART_MARGIN.left + band * 2.5,
    ]);
    expect(layout.bars.map((bar) => bar.d === '')).toEqual([true, false, false]);
    expect(layout.line).toBeNull();
    expect(layout.showMarkers).toBe(false);
  });

  it('survives an empty series and a container narrower than its margins', () => {
    const layout = layoutChart({ kind: 'bar', points: [], width: 10 });
    expect(layout.marks).toEqual([]);
    expect(layout.yMax).toBe(1);
    expect(layout.plot.right).toBeGreaterThan(layout.plot.left);
    expect(layoutChart({ kind: 'line', points: [], width: 0 }).line).toBeNull();
  });
});

describe('accessible summaries', () => {
  it('reads the key numbers of a line chart', () => {
    expect(lineSummary(volumeSeries(SQUAT), FORMAT)).toEqual({
      key: 'mobile.progression.chart.lineSummary',
      values: {
        count: 3,
        from: '1 Oct 2026',
        to: '8 Oct 2026',
        latest: '800',
        max: '800',
        min: '450',
      },
    });
    expect(lineSummary([], FORMAT)).toBeNull();
  });

  it('reads the totals of the frequency chart', () => {
    const weeks = frequencySeries([
      { weekStart: '2026-09-28', sessions: 4 },
      { weekStart: '2026-10-05', sessions: 0 },
      { weekStart: '2026-10-12', sessions: 2 },
    ]);
    expect(frequencySummary(weeks, FORMAT)).toEqual({
      key: 'mobile.progression.chart.barSummary',
      values: {
        weeks: 3,
        from: '28 Sept 2026',
        to: '12 Oct 2026',
        total: '6',
        max: '4',
        latest: '2',
      },
    });
  });

  it('has nothing to say when no session was logged', () => {
    const empty = frequencySeries([
      { weekStart: '2026-09-28', sessions: 0 },
      { weekStart: '2026-10-05', sessions: 0 },
    ]);
    expect(frequencySummary(empty, FORMAT)).toBeNull();
    expect(frequencySummary([], FORMAT)).toBeNull();
  });

  it('formats days in UTC and numbers per locale', () => {
    expect(formatUtcDay('2026-10-18', 'fr')).toBe('18 oct. 2026');
    expect(formatNumber(1250.55, 'en')).toBe('1,250.6');
    expect(formatNumber(1250.5, 'fr')).toMatch(/^1\s250,5$/u);
  });
});

describe('radioA11yProps', () => {
  it('exposes the radio role and its checked state', () => {
    expect(radioA11yProps({ label: '30 days', hint: 'Loads it', selected: true })).toEqual({
      accessible: true,
      accessibilityRole: 'radio',
      accessibilityLabel: '30 days',
      accessibilityHint: 'Loads it',
      accessibilityState: { checked: true, selected: true, disabled: false, busy: false },
    });
    expect(radioA11yProps({ label: '1 year', selected: false }).accessibilityState.checked).toBe(
      false,
    );
    expect(() => radioA11yProps({ label: ' ', selected: false })).toThrow(/label/u);
  });
});
