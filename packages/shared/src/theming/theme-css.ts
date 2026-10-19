/**
 * Builder for the shared theme stylesheet, `@athlya/shared/theme.css`.
 *
 * The web and studio apps import that one file from their `globals.css`
 * instead of keeping their own copy of the tokens, the shadcn/ui bridge
 * and the Tailwind 4 theme variables. The mobile app reads the same
 * tokens through its NativeWind preset (`apps/mobile/theme/preset.ts`).
 *
 * The builder is pure and takes the token objects as input so the
 * generator script (`scripts/generate-theme-css.ts`) can run it under
 * Node's type stripping, which does not resolve this package's `.js`
 * import specifiers. `tests/theme-css.test.ts` rebuilds the stylesheet
 * and fails when the committed file drifts from the tokens.
 *
 * Dark mode: next-themes writes `.dark` or `.light` on `<html>`. An
 * explicit class wins; without one (no JavaScript, first paint before
 * the script) the OS preference applies, as it did before next-themes.
 */
import type { BrandColorVariables } from './brand-color.js';
import type { Tokens } from '../tokens.js';

type Mode = 'light' | 'dark';
type SemanticColor = keyof Tokens['colors']['light'];

/**
 * A shadcn/ui variable is either a semantic token of the active mode or
 * the per-tenant brand colour, which is the same in both modes.
 */
type BridgeSource = SemanticColor | 'brandPrimary' | 'brandOnPrimary';

/**
 * shadcn/ui variable name to the Athlya token it reads. The bridge points
 * at the per-mode primitives (`--color-light-*`, `--color-dark-*`), never
 * at the active aliases, so `@theme inline` cannot resolve in a circle.
 */
export const SHADCN_BRIDGE: ReadonlyArray<readonly [string, BridgeSource]> = [
  ['background', 'background'],
  ['foreground', 'foreground'],
  ['card', 'background'],
  ['card-foreground', 'foreground'],
  ['popover', 'background'],
  ['popover-foreground', 'foreground'],
  ['primary', 'brandPrimary'],
  ['primary-foreground', 'brandOnPrimary'],
  ['secondary', 'secondary'],
  ['secondary-foreground', 'foreground'],
  ['muted', 'muted'],
  ['muted-foreground', 'mutedForeground'],
  ['accent', 'accent'],
  ['accent-foreground', 'foreground'],
  ['destructive', 'destructive'],
  ['border', 'border'],
  ['input', 'input'],
  ['ring', 'ring'],
  ['sidebar', 'background'],
  ['sidebar-foreground', 'foreground'],
  ['sidebar-primary', 'brandPrimary'],
  ['sidebar-primary-foreground', 'brandOnPrimary'],
  ['sidebar-accent', 'accent'],
  ['sidebar-accent-foreground', 'foreground'],
  ['sidebar-border', 'border'],
  ['sidebar-ring', 'ring'],
];

const SHADCN_COLORS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'border',
  'input',
  'ring',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
] as const;

const I = '  ';

function kebab(key: string): string {
  return key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

function value(raw: string | number): string {
  return typeof raw === 'number'
    ? raw.toString()
    : raw.replace(/#[0-9A-Fa-f]{6}\b/gu, (hex) => hex.toLowerCase());
}

function declarations(
  prefix: string,
  record: Readonly<Record<string, string | number>>,
  indent: string,
): string[] {
  return Object.entries(record).map(([k, v]) => `${indent}--${prefix}-${kebab(k)}: ${value(v)};`);
}

function bridgeSource(source: BridgeSource, mode: Mode): string {
  if (source === 'brandPrimary') return 'var(--athlya-brand-primary)';
  if (source === 'brandOnPrimary') return 'var(--athlya-brand-on-primary)';
  return `var(--color-${mode}-${kebab(source)})`;
}

/** Everything that changes between the light and the dark theme. */
function modeBlock(tokens: Tokens, mode: Mode, indent: string): string[] {
  const chart = tokens.chartColors[mode];
  return [
    `${indent}/* Active semantic colors (${mode}) */`,
    ...Object.keys(tokens.colors[mode]).map(
      (k) => `${indent}--color-${kebab(k)}: var(--color-${mode}-${kebab(k)});`,
    ),
    '',
    `${indent}/* shadcn/ui bridge (${mode}) */`,
    ...SHADCN_BRIDGE.map(([name, source]) => `${indent}--${name}: ${bridgeSource(source, mode)};`),
    '',
    `${indent}/* Progression charts: series, marker fill, hover/focus band (${mode}) */`,
    `${indent}--chart-1: ${value(chart.series)};`,
    `${indent}--chart-2: ${value(chart.marker)};`,
    `${indent}--chart-3: ${value(chart.band)};`,
  ];
}

/**
 * Serialize the tokens into the shared theme stylesheet.
 *
 * @param tokens - The aggregated `tokens` object from `@athlya/shared/tokens`.
 * @param brandDefaults - `deriveBrandColorVariables(colors.light.primary)`,
 *   the default per-tenant brand variables before any studio override.
 */
export function buildThemeCss(tokens: Tokens, brandDefaults: BrandColorVariables): string {
  const { colors, spacing, typography, radii, shadows, brandPalette } = tokens;
  const darkBlock = modeBlock(tokens, 'dark', `${I}${I}`);
  const lines: string[] = [
    '/*',
    ' * Athlya theme: design tokens as CSS custom properties, the shadcn/ui',
    ' * bridge and the Tailwind 4 theme variables, shared by web and studio.',
    ' *',
    ' * GENERATED FILE, do not edit by hand.',
    ' * Source of truth: packages/shared/src/tokens.ts',
    ' * Builder:         packages/shared/src/theming/theme-css.ts',
    ' * Regenerate with: pnpm --filter @athlya/shared run build:theme-css',
    ' *',
    ' * Dark mode: next-themes sets `.dark` or `.light` on <html>; without',
    ' * a class the OS preference applies.',
    ' */',
    '',
    '@custom-variant dark {',
    `${I}&:where(.dark, .dark *) {`,
    `${I}${I}@slot;`,
    `${I}}`,
    `${I}@media (prefers-color-scheme: dark) {`,
    `${I}${I}&:where(:root:not(.light), :root:not(.light) *) {`,
    `${I}${I}${I}@slot;`,
    `${I}${I}}`,
    `${I}}`,
    '}',
    '',
    ':root {',
    `${I}/* Brand palette of the logo: ink, volt, white */`,
    ...declarations('athlya-brand', brandPalette, I),
    '',
    `${I}/* Light theme semantic colors */`,
    ...declarations('color-light', colors.light, I),
    '',
    `${I}/* Dark theme semantic colors */`,
    ...declarations('color-dark', colors.dark, I),
    '',
    ...modeBlock(tokens, 'light', I),
    '',
    `${I}/* Spacing */`,
    ...declarations('spacing', spacing, I),
    '',
    `${I}/* Typography */`,
    ...declarations('font-family', typography.fontFamily, I),
    ...declarations('font-size', typography.fontSize, I),
    ...declarations('font-weight', typography.fontWeight, I),
    ...declarations('line-height', typography.lineHeight, I),
    '',
    `${I}/* Radii (--radius is the shadcn/ui base the rounded-* scale derives from) */`,
    ...declarations('radius', radii, I),
    `${I}--radius: ${radii.md};`,
    '',
    `${I}/* Shadows */`,
    ...declarations('shadow', shadows, I),
    '',
    `${I}/* Per-tenant brand color, overridden server-side by buildBrandColorCss */`,
    `${I}--athlya-brand-primary: ${value(brandDefaults.brandPrimary)};`,
    `${I}--athlya-brand-primary-rgb: ${brandDefaults.brandPrimaryRgb};`,
    `${I}--athlya-brand-on-primary: ${value(colors.light.primaryForeground)};`,
    `${I}--athlya-brand-primary-tint: ${value(brandDefaults.brandPrimaryTint)};`,
    `${I}--athlya-brand-primary-shade: ${value(brandDefaults.brandPrimaryShade)};`,
    '}',
    '',
    ':root.dark {',
    ...modeBlock(tokens, 'dark', I),
    '}',
    '',
    '@media (prefers-color-scheme: dark) {',
    `${I}:root:not(.light) {`,
    ...darkBlock,
    `${I}}`,
    '}',
    '',
    '@theme {',
    `${I}--color-brand-primary: var(--athlya-brand-primary);`,
    `${I}--color-brand-on-primary: var(--athlya-brand-on-primary);`,
    `${I}--color-brand-primary-tint: var(--athlya-brand-primary-tint);`,
    `${I}--color-brand-primary-shade: var(--athlya-brand-primary-shade);`,
    `${I}--color-success: var(--color-success);`,
    `${I}--color-warning: var(--color-warning);`,
    `${I}--font-sans: var(--font-family-sans);`,
    `${I}--font-mono: var(--font-family-mono);`,
    '}',
    '',
    '@theme inline {',
    `${I}--font-heading: var(--font-sans);`,
    `${I}--font-sans: var(--font-sans);`,
    ...SHADCN_COLORS.map((name) => `${I}--color-${name}: var(--${name});`),
    `${I}--spacing: var(--spacing-xs);`,
    ...Object.keys(typography.fontSize).map((k) => `${I}--text-${k}: var(--font-size-${k});`),
    `${I}--radius-sm: calc(var(--radius) * 0.6);`,
    `${I}--radius-md: calc(var(--radius) * 0.8);`,
    `${I}--radius-lg: var(--radius);`,
    `${I}--radius-xl: calc(var(--radius) * 1.4);`,
    `${I}--radius-2xl: calc(var(--radius) * 1.8);`,
    `${I}--radius-3xl: calc(var(--radius) * 2.2);`,
    `${I}--radius-4xl: calc(var(--radius) * 2.6);`,
    '}',
    '',
    'body {',
    `${I}background-color: var(--color-background);`,
    `${I}color: var(--color-foreground);`,
    `${I}font-family: var(--font-family-sans);`,
    `${I}font-size: var(--font-size-base);`,
    `${I}line-height: var(--line-height-normal);`,
    `${I}-webkit-font-smoothing: antialiased;`,
    `${I}text-rendering: optimizeLegibility;`,
    '}',
    '',
    '@layer base {',
    `${I}* {`,
    `${I}${I}border-color: var(--color-border);`,
    `${I}${I}outline-color: color-mix(in srgb, var(--color-ring) 50%, transparent);`,
    `${I}}`,
    `${I}body {`,
    `${I}${I}background-color: var(--color-background);`,
    `${I}${I}color: var(--color-foreground);`,
    `${I}}`,
    `${I}html {`,
    `${I}${I}font-family: var(--font-sans);`,
    `${I}}`,
    '}',
    '',
  ];
  return lines.join('\n');
}
