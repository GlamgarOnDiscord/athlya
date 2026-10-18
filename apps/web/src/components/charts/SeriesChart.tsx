/**
 * `<SeriesChart />` — accessible single-series SVG chart (line or bar).
 *
 * Accessibility (Requirements 27.1, 27.3):
 *  - The chart is a `<figure>` named by its caption and described by
 *    its description paragraph.
 *  - Each data mark is focusable with a roving tabindex: one Tab stop
 *    per chart, then ←/→ (or ↑/↓), Home and End move between values.
 *    Each mark has `role="img"` and an `aria-label` carrying its value,
 *    and the focused mark gets a visible ring plus a value readout.
 *  - A visually hidden `<table>` repeats every value for screen
 *    readers and other assistive technologies.
 *
 * Rendering is plain SVG with presentation attributes, so the strict
 * CSP (no inline script, no `style=""`, no `unsafe-eval`) is kept.
 * Colours come from theme tokens: the series uses `primary`, text uses
 * the foreground / muted tokens, the grid uses `border`.
 */
'use client';

import { useCallback, useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';

import {
  CHART_HEIGHT,
  CHART_MARGIN,
  CHART_WIDTH,
  PLOT_HEIGHT,
  PLOT_WIDTH,
  nextIndex,
  niceMax,
  ticks,
} from './chart-utils';

export interface SeriesDatum {
  /** Stable React key. */
  readonly key: string;
  /** Position on the x axis: epoch ms for a line chart, ignored for bars. */
  readonly x: number;
  readonly value: number;
  /** Label of the x value, used in the data table (e.g. a formatted date). */
  readonly xLabel: string;
  /** Full accessible label of the mark (e.g. "15 Oct: 500 kg"). */
  readonly label: string;
}

export interface SeriesChartProps {
  readonly kind: 'line' | 'bar';
  readonly title: string;
  readonly description: string;
  readonly data: readonly SeriesDatum[];
  /** Line charts: `[start, end)` of the x axis in epoch ms. */
  readonly xDomain?: readonly [number, number];
  /** Labels under the left and right ends of the x axis. */
  readonly axisLabels: readonly [string, string];
  /** Formats a y-axis tick and a table value. */
  readonly formatValue: (value: number) => string;
  /** Column headers of the data table: x then value. */
  readonly tableHeaders: readonly [string, string];
  /** Instructions announced when a mark gets focus. */
  readonly keyboardHint: string;
  /** Counts: keep y ticks on whole numbers. */
  readonly integerScale?: boolean;
}

const MARKER_LIMIT = 60;
const BASELINE = CHART_MARGIN.top + PLOT_HEIGHT;

/** Bar path with 4px rounded data-end and a square base on the baseline. */
function barPath(x: number, y: number, width: number): string {
  const height = BASELINE - y;
  if (height <= 0) return '';
  const r = Math.min(4, width / 2, height);
  return [
    `M${x},${BASELINE}`,
    `V${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `H${x + width - r}`,
    `Q${x + width},${y} ${x + width},${y + r}`,
    `V${BASELINE}`,
    'Z',
  ].join(' ');
}

export function SeriesChart({
  kind,
  title,
  description,
  data,
  xDomain,
  axisLabels,
  formatValue,
  tableHeaders,
  keyboardHint,
  integerScale = false,
}: SeriesChartProps): ReactElement {
  const id = useId();
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const hintId = `${id}-hint`;

  const [tabIndexAt, setTabIndexAt] = useState(Math.max(data.length - 1, 0));
  const [focused, setFocused] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const markRefs = useRef<Array<SVGGElement | null>>([]);

  const rovingIndex = Math.min(tabIndexAt, Math.max(data.length - 1, 0));
  const active = focused ?? hovered;

  const dataMax = Math.max(0, ...data.map((d) => d.value));
  const yMax = integerScale ? Math.max(4, Math.ceil(dataMax / 4) * 4) : niceMax(dataMax);
  const yOf = (value: number): number => BASELINE - (value / yMax) * PLOT_HEIGHT;

  const [x0, x1] = xDomain ?? [0, 1];
  const band = data.length > 0 ? PLOT_WIDTH / data.length : PLOT_WIDTH;
  const xOf = (datum: SeriesDatum, index: number): number =>
    kind === 'bar'
      ? CHART_MARGIN.left + band * (index + 0.5)
      : CHART_MARGIN.left + ((datum.x - x0) / Math.max(x1 - x0, 1)) * PLOT_WIDTH;

  const points = data.map((d, i) => ({ d, x: xOf(d, i), y: yOf(d.value) }));

  const onKeyDown = useCallback(
    (event: KeyboardEvent<SVGSVGElement>) => {
      const target = nextIndex(event.key, focused ?? rovingIndex, data.length);
      if (target === null) return;
      event.preventDefault();
      setTabIndexAt(target);
      markRefs.current[target]?.focus();
    },
    [data.length, focused, rovingIndex],
  );

  const linePath =
    kind === 'line' && points.length > 1
      ? points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
      : null;

  const barWidth = Math.max(Math.min(band - 2, band * 0.7), 1);
  const activePoint = active === null ? undefined : points[active];
  const readout = activePoint?.d.label ?? '';
  const readoutWidth = readout.length * 7 + 16;
  const readoutX =
    activePoint === undefined
      ? 0
      : Math.min(
          Math.max(activePoint.x - readoutWidth / 2, CHART_MARGIN.left),
          CHART_WIDTH - CHART_MARGIN.right - readoutWidth,
        );

  return (
    <figure aria-labelledby={titleId} aria-describedby={descId} className="flex flex-col gap-2">
      <figcaption id={titleId} className="font-medium">
        {title}
      </figcaption>
      <p id={descId} className="text-sm text-muted-foreground">
        {description}
      </p>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        role="group"
        aria-labelledby={titleId}
        className="h-auto w-full overflow-visible"
        onKeyDown={onKeyDown}
      >
        <g aria-hidden="true">
          {ticks(yMax).map((tick) => (
            <g key={tick}>
              <line
                x1={CHART_MARGIN.left}
                x2={CHART_WIDTH - CHART_MARGIN.right}
                y1={yOf(tick)}
                y2={yOf(tick)}
                className="stroke-border"
                strokeWidth={1}
              />
              <text
                x={CHART_MARGIN.left - 8}
                y={yOf(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-muted-foreground text-xs"
              >
                {formatValue(tick)}
              </text>
            </g>
          ))}
          <text
            x={CHART_MARGIN.left}
            y={CHART_HEIGHT - 8}
            className="fill-muted-foreground text-xs"
          >
            {axisLabels[0]}
          </text>
          <text
            x={CHART_WIDTH - CHART_MARGIN.right}
            y={CHART_HEIGHT - 8}
            textAnchor="end"
            className="fill-muted-foreground text-xs"
          >
            {axisLabels[1]}
          </text>
          {activePoint !== undefined && kind === 'bar' ? (
            <rect
              x={activePoint.x - band / 2}
              y={CHART_MARGIN.top}
              width={band}
              height={PLOT_HEIGHT}
              className="fill-muted"
            />
          ) : null}
          {activePoint !== undefined && kind === 'line' ? (
            <line
              x1={activePoint.x}
              x2={activePoint.x}
              y1={CHART_MARGIN.top}
              y2={BASELINE}
              className="stroke-muted-foreground"
              strokeWidth={1}
              strokeDasharray="4 4"
            />
          ) : null}
          {kind === 'bar'
            ? points.map((p) => (
                <path
                  key={p.d.key}
                  d={barPath(p.x - barWidth / 2, p.y, barWidth)}
                  className="fill-primary"
                />
              ))
            : null}
          {linePath !== null ? (
            <path
              d={linePath}
              fill="none"
              className="stroke-primary"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : null}
        </g>

        {points.map((p, i) => {
          const isActive = active === i;
          const showMarker = kind === 'line' && (data.length <= MARKER_LIMIT || isActive);
          return (
            <g
              key={p.d.key}
              ref={(node) => {
                markRefs.current[i] = node;
              }}
              role="img"
              aria-label={p.d.label}
              aria-describedby={hintId}
              tabIndex={i === rovingIndex ? 0 : -1}
              className="cursor-default outline-none"
              onFocus={() => {
                setFocused(i);
                setTabIndexAt(i);
              }}
              onBlur={() => {
                setFocused(null);
              }}
              onMouseEnter={() => {
                setHovered(i);
              }}
              onMouseLeave={() => {
                setHovered(null);
              }}
            >
              {kind === 'bar' ? (
                <rect
                  x={p.x - band / 2}
                  y={CHART_MARGIN.top}
                  width={band}
                  height={PLOT_HEIGHT}
                  fill="transparent"
                />
              ) : (
                <circle cx={p.x} cy={p.y} r={12} fill="transparent" />
              )}
              {showMarker ? (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={4.5}
                  className="fill-primary stroke-background"
                  strokeWidth={2}
                />
              ) : null}
              {focused === i ? (
                kind === 'bar' ? (
                  <rect
                    x={p.x - band / 2 + 1}
                    y={CHART_MARGIN.top + 1}
                    width={Math.max(band - 2, 1)}
                    height={PLOT_HEIGHT - 2}
                    fill="none"
                    className="stroke-foreground"
                    strokeWidth={2}
                  />
                ) : (
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={9}
                    fill="none"
                    className="stroke-foreground"
                    strokeWidth={2}
                  />
                )
              ) : null}
            </g>
          );
        })}

        {activePoint !== undefined ? (
          <g aria-hidden="true">
            <rect
              x={readoutX}
              y={2}
              width={readoutWidth}
              height={24}
              rx={4}
              className="fill-background stroke-border"
              strokeWidth={1}
            />
            <text
              x={readoutX + readoutWidth / 2}
              y={14}
              textAnchor="middle"
              dominantBaseline="middle"
              className="fill-foreground text-xs font-medium"
            >
              {readout}
            </text>
          </g>
        ) : null}
      </svg>
      <p id={hintId} className="sr-only">
        {keyboardHint}
      </p>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">{tableHeaders[0]}</th>
            <th scope="col">{tableHeaders[1]}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.key}>
              <th scope="row">{d.xLabel}</th>
              <td>{formatValue(d.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
