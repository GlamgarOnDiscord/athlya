/**
 * Tailwind (NativeWind) theme built from the shared design tokens in
 * `@athlya/shared/tokens`, so the mobile app and the web apps render the
 * same semantic palette, spacing, radii and type scale.
 *
 * Semantic colors become kebab-case utilities (`bg-primary-foreground`);
 * dark variants live under `dark-*` (`dark:bg-dark-background`). The logo
 * palette is `brand-ink`, `brand-volt` and `brand-white`.
 */
import { brandPalette, colors, radii, spacing, typography } from '@athlya/shared/tokens';

type Palette = Record<string, string>;

export function toKebabCase(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

function kebabKeys(palette: Readonly<Palette>, prefix = ''): Palette {
  return Object.fromEntries(
    Object.entries(palette).map(([key, value]) => [`${prefix}${toKebabCase(key)}`, value]),
  );
}

export interface MobileTheme {
  readonly colors: Palette;
  readonly spacing: Palette;
  readonly borderRadius: Palette;
  readonly fontSize: Palette;
  readonly fontWeight: Palette;
  readonly lineHeight: Palette;
}

export function buildMobileTheme(): MobileTheme {
  return {
    colors: {
      transparent: 'transparent',
      ...kebabKeys(colors.light),
      ...kebabKeys(colors.dark, 'dark-'),
      ...kebabKeys(brandPalette, 'brand-'),
    },
    spacing: { ...spacing },
    borderRadius: { ...radii },
    fontSize: { ...typography.fontSize },
    fontWeight: Object.fromEntries(
      Object.entries(typography.fontWeight).map(([key, value]) => [key, String(value)]),
    ),
    lineHeight: Object.fromEntries(
      Object.entries(typography.lineHeight).map(([key, value]) => [key, String(value)]),
    ),
  };
}
