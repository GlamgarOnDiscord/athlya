/**
 * WCAG 2.2 AA contrast of every foreground/background token pair, in both
 * themes, computed from the token values so a colour change that breaks
 * a pair fails CI.
 *
 * Levels: `text` needs 4.5:1, `large` (18pt, or 14pt bold) and `ui`
 * (focus indicators, component boundaries, chart marks) need 3:1.
 * https://www.w3.org/TR/WCAG22/#contrast-minimum and #non-text-contrast.
 *
 * `KNOWN_GAPS` lists the pairs that fail today and cannot be fixed without
 * restyling a screen. Each keeps a floor it may not drop below, and the
 * test fails once a gap passes, so the entry is removed rather than left
 * stale. They are scheduled for the screen PRs (docs/design/ui-direction.md).
 */
import { describe, expect, it } from 'vitest';

import { contrastRatio } from '../src/theming/brand-color';
import { SHADCN_BRIDGE } from '../src/theming/theme-css';
import { brandPalette, chartColors, colors } from '../src/tokens';

type Mode = 'light' | 'dark';
type Level = 'text' | 'large' | 'ui';
type Semantic = keyof (typeof colors)['light'];

const MIN_RATIO: Record<Level, number> = { text: 4.5, large: 3, ui: 3 };
const MODES: readonly Mode[] = ['light', 'dark'];

interface Pair {
  readonly name: string;
  readonly fg: string;
  readonly bg: string;
  readonly level: Level;
}

/** sRGB blend of `top` at `alpha` over `bottom`, for `bg-x/10` style tints. */
function over(top: string, alpha: number, bottom: string): string {
  const channel = (hex: string, i: number): number => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const mixed = [0, 1, 2].map((i) =>
    Math.round(channel(top, i) * alpha + channel(bottom, i) * (1 - alpha))
      .toString(16)
      .padStart(2, '0'),
  );
  return `#${mixed.join('')}`;
}

/** Resolves a shadcn/ui bridge source the way `theme.css` does. */
function bridgeColor(source: string, mode: Mode): string {
  if (source === 'brandPrimary') return colors.light.primary;
  if (source === 'brandOnPrimary') return colors.light.primaryForeground;
  return colors[mode][source as Semantic];
}

function pairsFor(mode: Mode): Pair[] {
  const c = colors[mode];
  const bridge = new Map(SHADCN_BRIDGE.map(([name, source]) => [name, source as string]));
  const bridgePairs: Pair[] = [...bridge.entries()]
    .filter(([name]) => name.endsWith('-foreground'))
    .map(([name, source]) => {
      const surface = bridge.get(name.replace(/-foreground$/u, '')) ?? 'background';
      return {
        name: `--${name} on --${name.replace(/-foreground$/u, '')}`,
        fg: bridgeColor(source, mode),
        bg: bridgeColor(surface, mode),
        level: 'text',
      };
    });

  const text = (fg: Semantic, bg: Semantic): Pair => ({
    name: `${fg} on ${bg}`,
    fg: c[fg],
    bg: c[bg],
    level: 'text',
  });
  const ui = (fg: Semantic, bg: Semantic): Pair => ({ ...text(fg, bg), level: 'ui' });
  const tintAlpha = mode === 'light' ? 0.1 : 0.2;

  return [
    ...bridgePairs,
    text('foreground', 'background'),
    text('foreground', 'secondary'),
    text('foreground', 'muted'),
    text('foreground', 'accent'),
    text('mutedForeground', 'background'),
    text('mutedForeground', 'secondary'),
    text('mutedForeground', 'muted'),
    text('primaryForeground', 'primary'),
    text('destructive', 'background'),
    text('success', 'background'),
    text('warning', 'background'),
    {
      name: `destructive on destructive/${(tintAlpha * 100).toString()} (destructive button, badge)`,
      fg: c.destructive,
      bg: over(c.destructive, tintAlpha, c.background),
      level: 'text',
    },
    ui('ring', 'background'),
    ui('ring', 'muted'),
    ui('destructive', 'background'),
    ui('success', 'background'),
    ui('warning', 'background'),
    {
      name: 'chart series on background',
      fg: chartColors[mode].series,
      bg: c.background,
      level: 'ui',
    },
    { name: 'chart series on muted', fg: chartColors[mode].series, bg: c.muted, level: 'ui' },
  ];
}

interface KnownGap {
  readonly name: string;
  readonly mode: Mode;
  readonly fg: string;
  readonly bg: string;
  readonly level: Level;
  /** Ratio measured when the gap was recorded; it may only go up. */
  readonly floor: number;
}

const KNOWN_GAPS: readonly KnownGap[] = [
  ...MODES.map((mode) => ({
    name: 'input on background (web form field boundary, shadcn border-input)',
    mode,
    fg: colors[mode].input,
    bg: colors[mode].background,
    level: 'ui' as const,
    floor: mode === 'light' ? 1.23 : 1.28,
  })),
  ...MODES.map((mode) => ({
    name: 'border on background (mobile TextField boundary)',
    mode,
    fg: colors[mode].border,
    bg: colors[mode].background,
    level: 'ui' as const,
    floor: mode === 'light' ? 1.23 : 1.28,
  })),
  {
    name: 'primary on background (checked checkbox fill, capacity bar)',
    mode: 'light',
    fg: colors.light.primary,
    bg: colors.light.background,
    level: 'ui',
    floor: 2.77,
  },
];

describe('token contrast (WCAG 2.2 AA)', () => {
  for (const mode of MODES) {
    describe(`${mode} theme`, () => {
      it.each(pairsFor(mode))('$name meets its $level minimum', ({ fg, bg, level }) => {
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(MIN_RATIO[level]);
      });
    });
  }

  it.each(KNOWN_GAPS)('known gap: $name ($mode) does not regress', ({ fg, bg, floor, level }) => {
    const ratio = contrastRatio(fg, bg);
    expect(ratio).toBeGreaterThanOrEqual(floor - 0.005);
    expect(ratio, 'gap now passes: remove it from KNOWN_GAPS').toBeLessThan(MIN_RATIO[level]);
  });
});

describe('logo palette (docs/brand/README.md)', () => {
  it('keeps the logo colours unchanged', () => {
    expect(brandPalette).toEqual({ ink: '#0A0A0A', volt: '#D7FF3A', white: '#FFFFFF' });
  });

  it('ink on white and on the light background reads as text', () => {
    expect(contrastRatio(brandPalette.ink, brandPalette.white)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(brandPalette.ink, colors.light.background)).toBeGreaterThanOrEqual(4.5);
  });

  it('volt on ink and on the dark background reads as text', () => {
    expect(contrastRatio(brandPalette.volt, brandPalette.ink)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(brandPalette.volt, colors.dark.background)).toBeGreaterThanOrEqual(4.5);
  });

  it('studio planning marks read as text: volt and white pills, today bar, now line', () => {
    expect(contrastRatio(brandPalette.ink, brandPalette.volt)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(brandPalette.white, brandPalette.ink)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(brandPalette.ink, colors.light.background)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(brandPalette.volt, colors.dark.background)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(brandPalette.white, colors.dark.muted)).toBeGreaterThanOrEqual(3);
  });

  it('studio dashboard marks: fill meter on its track, live pill', () => {
    for (const mode of MODES) {
      expect(contrastRatio(chartColors[mode].series, colors[mode].muted)).toBeGreaterThanOrEqual(3);
    }
    expect(contrastRatio(brandPalette.ink, brandPalette.volt)).toBeGreaterThanOrEqual(4.5);
  });

  it('volt on white stays forbidden: below even the 3:1 UI minimum', () => {
    expect(contrastRatio(brandPalette.volt, brandPalette.white)).toBeLessThan(3);
  });
});
