import { colors } from '@athlya/shared/tokens';
import { useState } from 'react';
import { useColorScheme, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';

import {
  CHART_HEIGHT,
  layoutChart,
  type SeriesPoint,
} from '../features/progression/progression-charts';

import { AppText } from './ui/AppText';

export interface SeriesChartProps {
  readonly kind: 'line' | 'bar';
  readonly title: string;
  readonly description: string;
  readonly points: readonly SeriesPoint[];
  /**
   * Spoken instead of the drawing: the key numbers of the series (see
   * `lineSummary` / `frequencySummary`).
   */
  readonly summary: string;
  /** Line charts: `[start, end)` of the x axis in epoch ms. */
  readonly xDomain?: readonly [number, number];
  /** Labels under the left and right ends of the x axis. */
  readonly axisLabels: readonly [string, string];
  readonly formatTick: (value: number) => string;
  /** Counts: keep the y ticks on whole numbers. */
  readonly integerScale?: boolean;
}

/**
 * Single-series line or bar chart drawn with `react-native-svg`, with the
 * same scale and path maths as the web charts (`@athlya/shared/charts`).
 *
 * VoiceOver and TalkBack cannot explore SVG marks, so the drawing is one
 * `image` element whose label is the title plus a summary of the values;
 * the SVG itself is hidden from assistive technologies. Colours are the
 * theme tokens: series in `foreground`, markers in `primary`, grid in
 * `border`, labels in `mutedForeground`.
 */
export function SeriesChart({
  kind,
  title,
  description,
  points,
  summary,
  xDomain,
  axisLabels,
  formatTick,
  integerScale = false,
}: SeriesChartProps) {
  const theme = useColorScheme() === 'dark' ? colors.dark : colors.light;
  const [width, setWidth] = useState(0);
  const onLayout = (event: LayoutChangeEvent) => {
    setWidth(Math.round(event.nativeEvent.layout.width));
  };
  const layout =
    width > 0
      ? layoutChart({
          kind,
          points,
          width,
          ...(xDomain === undefined ? {} : { xDomain }),
          integerScale,
        })
      : null;

  return (
    <View className="gap-xs">
      <AppText className="font-semibold">{title}</AppText>
      <AppText variant="muted">{description}</AppText>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={`${title}. ${summary}`}
        onLayout={onLayout}
        style={{ height: CHART_HEIGHT }}
      >
        {layout === null ? null : (
          <Svg
            width={layout.width}
            height={layout.height}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {layout.ticks.map((tick) => (
              <Line
                key={`grid-${String(tick.value)}`}
                x1={layout.plot.left}
                x2={layout.plot.right}
                y1={tick.y}
                y2={tick.y}
                stroke={theme.border}
                strokeWidth={1}
              />
            ))}
            {layout.ticks.map((tick) => (
              <SvgText
                key={`label-${String(tick.value)}`}
                x={layout.plot.left - 6}
                y={tick.y + 4}
                fontSize={11}
                textAnchor="end"
                fill={theme.mutedForeground}
              >
                {formatTick(tick.value)}
              </SvgText>
            ))}
            <SvgText
              x={layout.plot.left}
              y={layout.height - 8}
              fontSize={11}
              fill={theme.mutedForeground}
            >
              {axisLabels[0]}
            </SvgText>
            <SvgText
              x={layout.plot.right}
              y={layout.height - 8}
              fontSize={11}
              textAnchor="end"
              fill={theme.mutedForeground}
            >
              {axisLabels[1]}
            </SvgText>
            {layout.bars.map((bar) => (
              <Path key={bar.key} d={bar.d} fill={theme.foreground} />
            ))}
            {layout.line === null ? null : (
              <Path
                d={layout.line}
                fill="none"
                stroke={theme.foreground}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
            {layout.showMarkers
              ? layout.marks.map((mark) => (
                  <Circle
                    key={mark.key}
                    cx={mark.x}
                    cy={mark.y}
                    r={4}
                    fill={theme.primary}
                    stroke={theme.foreground}
                    strokeWidth={1.5}
                  />
                ))
              : null}
          </Svg>
        )}
      </View>
    </View>
  );
}
