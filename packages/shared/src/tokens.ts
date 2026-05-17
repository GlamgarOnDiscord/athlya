/**
 * Athlya design tokens — the single source of truth for colors, spacing,
 * typography, radii and shadows used across the web, studio admin and mobile
 * apps. Every token is declared `as const` so consumers get literal types
 * and tree-shakers can safely inline values.
 *
 * Usage:
 * ```ts
 * import { tokens, colors, spacing } from '@athlya/shared/tokens';
 * const bg = tokens.colors.light.background;
 * const pad = spacing.md;
 * ```
 */

/**
 * Semantic color tokens per theme.
 *
 * Tokens are intentionally semantic (e.g. `background`, `primary`) rather than
 * physical (e.g. `blue500`) so theme overrides at the studio level can remap
 * brand colors without rewriting components. Light and dark variants share
 * the same keys — consumers pick a variant based on the current theme.
 *
 * Default `primary` is the Athlya brand blue `#0EA5E9`.
 */
export const colors = {
  light: {
    background: '#FFFFFF',
    foreground: '#0F172A',
    primary: '#0EA5E9',
    primaryForeground: '#0F172A',
    secondary: '#F1F5F9',
    muted: '#F1F5F9',
    mutedForeground: '#475569',
    accent: '#E0F2FE',
    destructive: '#DC2626',
    success: '#16A34A',
    warning: '#D97706',
    border: '#E2E8F0',
    input: '#E2E8F0',
    ring: '#0EA5E9',
  },
  dark: {
    background: '#0B1220',
    foreground: '#F8FAFC',
    primary: '#38BDF8',
    primaryForeground: '#0B1220',
    secondary: '#1E293B',
    muted: '#1E293B',
    mutedForeground: '#94A3B8',
    accent: '#0C4A6E',
    destructive: '#F87171',
    success: '#4ADE80',
    warning: '#FBBF24',
    border: '#1E293B',
    input: '#1E293B',
    ring: '#38BDF8',
  },
} as const;

/**
 * Spacing scale in `rem` units. Prefer semantic steps (`md`, `lg`) over raw
 * values so visual rhythm stays consistent across platforms.
 */
export const spacing = {
  xs: '0.25rem',
  sm: '0.5rem',
  md: '1rem',
  lg: '1.5rem',
  xl: '2rem',
  '2xl': '3rem',
  '3xl': '4rem',
} as const;

/**
 * Typography tokens — font families, sizes, weights and line heights.
 *
 * `fontFamily.sans` is the product default (Inter); `fontFamily.mono` is
 * reserved for numeric tabular data and code snippets.
 */
export const typography = {
  fontFamily: {
    sans: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    mono: 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  fontSize: {
    xs: '0.75rem',
    sm: '0.875rem',
    base: '1rem',
    lg: '1.125rem',
    xl: '1.25rem',
    '2xl': '1.5rem',
    '3xl': '1.875rem',
    '4xl': '2.25rem',
  },
  fontWeight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  lineHeight: {
    tight: 1.2,
    normal: 1.5,
    relaxed: 1.75,
  },
} as const;

/**
 * Corner radii scale. `full` is used for avatars and pill-shaped buttons.
 */
export const radii = {
  sm: '0.25rem',
  md: '0.5rem',
  lg: '0.75rem',
  xl: '1rem',
  full: '9999px',
} as const;

/**
 * Elevation / box-shadow scale.
 *
 * These shadows assume a light background; themes that invert the palette
 * should reduce opacity or swap to a subtle highlight on dark surfaces.
 */
export const shadows = {
  sm: '0 1px 2px 0 rgba(15, 23, 42, 0.05)',
  md: '0 4px 6px -1px rgba(15, 23, 42, 0.10), 0 2px 4px -2px rgba(15, 23, 42, 0.10)',
  lg: '0 10px 15px -3px rgba(15, 23, 42, 0.10), 0 4px 6px -4px rgba(15, 23, 42, 0.10)',
} as const;

/**
 * Aggregated tokens object — convenient single import for consumers that
 * want the whole design system. Prefer the named exports above when a
 * subset suffices, so bundlers can tree-shake more aggressively.
 */
export const tokens = {
  colors,
  spacing,
  typography,
  radii,
  shadows,
} as const;

export type Tokens = typeof tokens;
export type Colors = typeof colors;
export type ColorTheme = keyof typeof colors;
export type SemanticColor = keyof (typeof colors)['light'];
export type Spacing = keyof typeof spacing;
export type FontSize = keyof (typeof typography)['fontSize'];
export type FontWeight = keyof (typeof typography)['fontWeight'];
export type LineHeight = keyof (typeof typography)['lineHeight'];
export type Radius = keyof typeof radii;
export type Shadow = keyof typeof shadows;
