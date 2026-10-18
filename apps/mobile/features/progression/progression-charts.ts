/**
 * Pure models behind the progression charts: the series read from the
 * API body, the pixel layout drawn by `components/SeriesChart.tsx`, and the
 * spoken summary every chart carries as its accessibility label.
 */
import { barPath, dayMs, linePath, ticks, yAxisMax } from '@athlya/shared/charts';

import type { Message } from '../programs/today-program';
import type { ExerciseProgression, WeeklyFrequency } from '@athlya/shared/schemas/api';

const HALF_DAY_MS = 12 * 60 * 60 * 1000;

/** One value of a chart; `date` is the `YYYY-MM-DD` UTC day (or week start). */
export interface SeriesPoint {
  readonly key: string;
  readonly date: string;
  /** Epoch ms on the x axis (line charts; bars are laid out by index). */
  readonly x: number;
  readonly value: number;
}

/** Daily volume of one exercise, plotted at the middle of each UTC day. */
export function volumeSeries(exercise: ExerciseProgression): SeriesPoint[] {
  return exercise.points.map((point) => ({
    key: point.date,
    date: point.date,
    x: dayMs(point.date) + HALF_DAY_MS,
    value: point.volumeKg,
  }));
}

/** Best estimated 1RM per day; days without a qualifying set are left out. */
export function oneRepMaxSeries(exercise: ExerciseProgression): SeriesPoint[] {
  return exercise.points.flatMap((point) =>
    point.estimatedOneRepMaxKg === null
      ? []
      : [
          {
            key: point.date,
            date: point.date,
            x: dayMs(point.date) + HALF_DAY_MS,
            value: point.estimatedOneRepMaxKg,
          },
        ],
  );
}

/** Sessions per ISO week, oldest first (the API zero-fills empty weeks). */
export function frequencySeries(weeks: readonly WeeklyFrequency[]): SeriesPoint[] {
  return weeks.map((week) => ({
    key: week.weekStart,
    date: week.weekStart,
    x: dayMs(week.weekStart),
    value: week.sessions,
  }));
}

/**
 * First and last UTC day of the response window `[from, to)`, for the
 * labels under the x axis (`to` is the midnight after the last day).
 */
export function windowBounds(from: string, to: string): readonly [string, string] {
  const utcDay = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);
  return [utcDay(Date.parse(from)), utcDay(Date.parse(to) - 1)];
}

/* ------------------------------------------------------------------ */
/*  Layout                                                             */
/* ------------------------------------------------------------------ */

export const CHART_HEIGHT = 200;
export const CHART_MARGIN = { top: 12, right: 12, bottom: 28, left: 44 } as const;
/** Beyond this many points a line chart drops its per-point markers. */
export const MARKER_LIMIT = 60;

export interface LayoutInput {
  readonly kind: 'line' | 'bar';
  readonly points: readonly SeriesPoint[];
  /** Drawing width in px (the measured container width). */
  readonly width: number;
  readonly height?: number;
  /** Line charts: `[start, end)` of the x axis in epoch ms. */
  readonly xDomain?: readonly [number, number];
  /** Counts: keep the y ticks on whole numbers. */
  readonly integerScale?: boolean;
}

export interface ChartMark {
  readonly key: string;
  readonly x: number;
  readonly y: number;
}

export interface ChartLayout {
  readonly width: number;
  readonly height: number;
  readonly plot: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  };
  readonly yMax: number;
  /** Gridlines, bottom to top. */
  readonly ticks: ReadonlyArray<{ readonly value: number; readonly y: number }>;
  /** Centre of each value: the line vertex, or the top-middle of the bar. */
  readonly marks: readonly ChartMark[];
  readonly line: string | null;
  readonly bars: ReadonlyArray<{ readonly key: string; readonly d: string }>;
  readonly showMarkers: boolean;
}

export function layoutChart(input: LayoutInput): ChartLayout {
  const height = input.height ?? CHART_HEIGHT;
  const width = Math.max(input.width, CHART_MARGIN.left + CHART_MARGIN.right + 1);
  const plot = {
    left: CHART_MARGIN.left,
    right: width - CHART_MARGIN.right,
    top: CHART_MARGIN.top,
    bottom: height - CHART_MARGIN.bottom,
  };
  const plotWidth = plot.right - plot.left;
  const plotHeight = plot.bottom - plot.top;

  const dataMax = Math.max(0, ...input.points.map((point) => point.value));
  const yMax = yAxisMax(dataMax, input.integerScale === true);
  const yOf = (value: number): number => plot.bottom - (value / yMax) * plotHeight;

  const count = input.points.length;
  const band = count > 0 ? plotWidth / count : plotWidth;
  const [x0, x1] = input.xDomain ?? [
    Math.min(...input.points.map((point) => point.x)),
    Math.max(...input.points.map((point) => point.x)),
  ];
  const span = Number.isFinite(x1 - x0) ? Math.max(x1 - x0, 1) : 1;
  const xOf = (point: SeriesPoint, index: number): number => {
    if (input.kind === 'bar') return plot.left + band * (index + 0.5);
    if (input.xDomain === undefined && count === 1) return plot.left + plotWidth / 2;
    return plot.left + ((point.x - x0) / span) * plotWidth;
  };

  const marks = input.points.map((point, index) => ({
    key: point.key,
    x: xOf(point, index),
    y: yOf(point.value),
  }));
  const barWidth = Math.max(Math.min(band - 2, band * 0.7), 1);

  return {
    width,
    height,
    plot,
    yMax,
    ticks: ticks(yMax).map((value) => ({ value, y: yOf(value) })),
    marks,
    line: input.kind === 'line' ? linePath(marks) : null,
    bars:
      input.kind === 'bar'
        ? marks.map((mark) => ({
            key: mark.key,
            d: barPath(mark.x - barWidth / 2, mark.y, barWidth, plot.bottom),
          }))
        : [],
    showMarkers: input.kind === 'line' && count <= MARKER_LIMIT,
  };
}

/* ------------------------------------------------------------------ */
/*  Accessible summaries                                               */
/* ------------------------------------------------------------------ */

export interface SummaryFormat {
  /** A `YYYY-MM-DD` UTC day, e.g. "18 Oct 2026". */
  readonly day: (date: string) => string;
  /** A measurement or count, e.g. "1,250.5". */
  readonly number: (value: number) => string;
}

/**
 * What a screen reader says for a line chart: how many days were
 * trained, over which dates, and the latest, highest and lowest values.
 * `null` when there is nothing to chart (the screen shows its empty state).
 */
export function lineSummary(points: readonly SeriesPoint[], format: SummaryFormat): Message | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return null;
  const values = points.map((point) => point.value);
  return {
    key: 'mobile.progression.chart.lineSummary',
    values: {
      count: points.length,
      from: format.day(first.date),
      to: format.day(last.date),
      latest: format.number(last.value),
      max: format.number(Math.max(...values)),
      min: format.number(Math.min(...values)),
    },
  };
}

/**
 * What a screen reader says for the weekly frequency chart: the number
 * of weeks, total sessions, the busiest week and the latest week. `null`
 * when no session was logged in the window.
 */
export function frequencySummary(
  points: readonly SeriesPoint[],
  format: SummaryFormat,
): Message | null {
  const total = points.reduce((sum, point) => sum + point.value, 0);
  const first = points[0];
  const last = points[points.length - 1];
  if (total === 0 || first === undefined || last === undefined) return null;
  return {
    key: 'mobile.progression.chart.barSummary',
    values: {
      weeks: points.length,
      from: format.day(first.date),
      to: format.day(last.date),
      total: format.number(total),
      max: format.number(Math.max(...points.map((point) => point.value))),
      latest: format.number(last.value),
    },
  };
}
