/**
 * Live contrast reading of a brand color for the branding editor
 * (issue #761), on the helpers the API gate uses.
 *
 *   - `onPrimary` / `ratio`: the text color paired with the brand color
 *     when it fills a button or an e-mail header, and their contrast.
 *     Below WCAG AA (4.5:1) the API refuses the color.
 *   - `onLight` / `onDark`: contrast of the brand color itself against
 *     the light (white) and dark (ink) surfaces. Under 4.5:1 it must not
 *     carry text on that surface, under 3:1 not even an icon or a
 *     border (WCAG 1.4.11): the editor warns, it does not refuse.
 */

import {
  contrastRatio,
  evaluateBrandContrast,
  parseBrandColor,
  WCAG_AA_NORMAL_TEXT_RATIO,
} from '@athlya/shared/theming';

/** WCAG 1.4.11 minimum for icons, borders and other UI components. */
export const WCAG_NON_TEXT_RATIO = 3;

const LIGHT_SURFACE = '#FFFFFF';
const DARK_SURFACE = '#0A0A0A';

export type SurfaceUse = 'text' | 'graphics' | 'fill';

export interface BrandContrastReading {
  readonly color: string;
  readonly onPrimary: string;
  readonly ratio: number;
  readonly meetsAa: boolean;
  readonly onLight: { readonly ratio: number; readonly use: SurfaceUse };
  readonly onDark: { readonly ratio: number; readonly use: SurfaceUse };
}

function surfaceUse(ratio: number): SurfaceUse {
  if (ratio >= WCAG_AA_NORMAL_TEXT_RATIO) return 'text';
  if (ratio >= WCAG_NON_TEXT_RATIO) return 'graphics';
  return 'fill';
}

/** Reading of `raw`, or `null` when it is not a `#RRGGBB` color. */
export function readBrandContrast(raw: string): BrandContrastReading | null {
  const color = parseBrandColor(raw.trim());
  if (color === null) return null;
  const pairing = evaluateBrandContrast(color);
  const light = contrastRatio(color, LIGHT_SURFACE);
  const dark = contrastRatio(color, DARK_SURFACE);
  return {
    color: color.toUpperCase(),
    onPrimary: pairing.onPrimary.toUpperCase(),
    ratio: pairing.ratio,
    meetsAa: pairing.meetsAa,
    onLight: { ratio: light, use: surfaceUse(light) },
    onDark: { ratio: dark, use: surfaceUse(dark) },
  };
}

/** `4.58:1` style label, one decimal. */
export function formatRatio(ratio: number): string {
  return `${(Math.floor(ratio * 10) / 10).toFixed(1)}:1`;
}
