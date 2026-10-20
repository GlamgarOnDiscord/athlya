/**
 * Per-tenant brand color helpers — task 15.2.
 *
 * The `studio.brand_color` column (and its mirror in the Studio Zod
 * schema, `packages/shared/schemas/domain.ts`) is the one knob every
 * tenant has to retint the product UI. This module is the pure,
 * framework-free bridge between that stored `#RRGGBB` value and the
 * concrete theme tokens the web, studio and mobile clients consume.
 *
 * Nothing here performs I/O, touches the DOM, or imports React /
 * React Native — so the helpers are safe to call during SSR, inside
 * a service worker, from a worker thread, or at build time.
 *
 * ## Integration points
 *
 * ### Web / Studio (Next.js — Epic 10 and Epic 12)
 *
 * In the Next.js root layout, the tenant resolver (task 15.1) returns
 * the studio's `brandColor`. Pass it to {@link buildBrandColorCss} and
 * render the result inside an inline `<style>` tag in `<head>`.
 * Tailwind 4 components reference the CSS variables via arbitrary
 * values, e.g. `bg-[var(--athlya-brand-primary)]`.
 *
 * ```tsx
 * // app/layout.tsx (server component)
 * import { buildBrandColorCss } from '@athlya/shared/theming';
 *
 * export default async function RootLayout({ children }) {
 *   const tenant = await resolveTenant();
 *   return (
 *     <html>
 *       <head>
 *         <style dangerouslySetInnerHTML={{ __html: buildBrandColorCss(tenant.brandColor) }} />
 *       </head>
 *       <body>{children}</body>
 *     </html>
 *   );
 * }
 * ```
 *
 * ### Mobile (Expo / React Native — Epic 11)
 *
 * The Expo root provides a `TenantThemeProvider` that wraps NativeWind's
 * theme with `buildRNBrandTheme(color).brand`. Components use the
 * `brand-primary` / `brand-on-primary` utility classes which NativeWind
 * resolves against the provided theme.
 *
 * ```tsx
 * // App.tsx
 * import { buildRNBrandTheme } from '@athlya/shared/theming';
 * const theme = buildRNBrandTheme(tenant.brandColor);
 * ```
 *
 * ## Why re-validate the hex here?
 *
 * The Studio schema already pins `brandColor` to `^#[0-9A-Fa-f]{6}$`
 * via Zod. This module still re-validates with {@link parseBrandColor}
 * so that callers receiving a `string` from an HTTP header, cookie or
 * query parameter (i.e. anywhere Zod hasn't already run) stay
 * type-safe without having to re-import the schema.
 *
 * Related requirements: design §Components, Studio model.
 */

/**
 * Strict `#RRGGBB` matcher. 3-digit short form (`#fff`) is rejected
 * on purpose — the Studio model pins 6 digits, this helper enforces
 * it again at runtime.
 */
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/u;

/**
 * WCAG 2.2 relative luminance threshold used to pick between a dark
 * and a light foreground on top of the brand color.
 *
 * Derivation: the contrast ratio `(L1 + 0.05) / (L2 + 0.05)` must be
 * ≥ 4.5:1 against both black (L=0) and white (L=1). Solving both
 * inequalities with equality gives a crossover at
 * L ≈ `sqrt(1.05 * 0.05) - 0.05 ≈ 0.179`. Anything strictly above
 * the threshold is treated as a "light" brand and pairs with black
 * text; anything at or below pairs with white text.
 */
const LUMINANCE_CROSSOVER = 0.179;

/**
 * Fraction used for {@link BrandColorVariables.brandPrimaryTint} and
 * {@link BrandColorVariables.brandPrimaryShade}. Linear interpolation
 * in sRGB (not HSL) matches what designers eyeball in Figma and keeps
 * the computation cheap — at the cost of a marginally non-perceptual
 * ramp, which is acceptable for a 15% delta.
 */
const TINT_SHADE_AMOUNT = 0.15;

/**
 * Validate a brand color.
 *
 * @param raw - Candidate string, typically coming from a tenant row or
 *   a request header.
 * @returns The normalised lowercase `#rrggbb` form, or `null` if the
 *   input is not a valid 6-digit hex color.
 */
export function parseBrandColor(raw: string): string | null {
  if (!HEX_COLOR_RE.test(raw)) {
    return null;
  }
  return raw.toLowerCase();
}

/**
 * The CSS-variable map emitted by {@link buildBrandColorCss}. Exposed
 * as its own function so callers that want the values without string
 * formatting (mobile `buildRNBrandTheme`, server-side RN theme
 * overrides) can consume them directly.
 */
export interface BrandColorVariables {
  /** The raw brand color in normalised `#rrggbb` form. */
  readonly brandPrimary: string;
  /**
   * `"r, g, b"` (note the space after each comma). Designed to be
   * dropped into `rgba(var(--athlya-brand-primary-rgb), 0.4)` for
   * opacity-adjusted surfaces.
   */
  readonly brandPrimaryRgb: string;
  /**
   * Contrast text color for surfaces painted with `brandPrimary` —
   * `#000000` for a light brand, `#ffffff` for a dark brand. Decided
   * with WCAG 2.2 relative luminance, so pairs respect the 4.5:1
   * contrast minimum against both endpoints.
   */
  readonly brandOnPrimary: string;
  /** `brandPrimary` interpolated 15% toward white. */
  readonly brandPrimaryTint: string;
  /** `brandPrimary` interpolated 15% toward black. */
  readonly brandPrimaryShade: string;
}

/**
 * Compute the five brand tokens derived from a validated hex color.
 *
 * @throws {TypeError} If `brand` is not a valid `#RRGGBB` hex string.
 *   Callers that cannot guarantee validation should run
 *   {@link parseBrandColor} first.
 */
export function deriveBrandColorVariables(brand: string): BrandColorVariables {
  const normalised = parseBrandColor(brand);
  if (normalised === null) {
    throw new TypeError(
      `deriveBrandColorVariables expected a #RRGGBB hex color, received ${JSON.stringify(brand)}`,
    );
  }

  const [r, g, b] = parseHexChannels(normalised);
  const luminance = relativeLuminance(r, g, b);
  const onPrimary = luminance > LUMINANCE_CROSSOVER ? '#000000' : '#ffffff';

  const tint = mixToward(r, g, b, 255, 255, 255, TINT_SHADE_AMOUNT);
  const shade = mixToward(r, g, b, 0, 0, 0, TINT_SHADE_AMOUNT);

  return {
    brandPrimary: normalised,
    brandPrimaryRgb: `${r.toString()}, ${g.toString()}, ${b.toString()}`,
    brandOnPrimary: onPrimary,
    brandPrimaryTint: tint,
    brandPrimaryShade: shade,
  };
}

/**
 * The theme declares per-mode brand defaults under `:root.dark` and
 * `:root:not(.light)`, which outrank a bare `:root`. A tenant override
 * at the default selector uses `html:root` variants so it wins in both
 * modes, whatever order the stylesheets load in.
 */
const TENANT_ROOT_SELECTOR = 'html:root, html:root.dark, html:root:not(.light)';

/**
 * Produce a CSS snippet that sets the five brand CSS custom
 * properties under `selector` (default `:root`, emitted so it outranks
 * the theme's light and dark defaults). Meant to be rendered
 * server-side by the web / studio apps inside an inline `<style>`
 * tag.
 *
 * The emitted variables are:
 *   - `--athlya-brand-primary`
 *   - `--athlya-brand-primary-rgb`
 *   - `--athlya-brand-on-primary`
 *   - `--athlya-brand-primary-tint`
 *   - `--athlya-brand-primary-shade`
 *
 * @throws {TypeError} If `brand` is not a valid `#RRGGBB` hex string.
 */
export function buildBrandColorCss(brand: string, selector: string = ':root'): string {
  const vars = deriveBrandColorVariables(brand);
  return [
    `${selector === ':root' ? TENANT_ROOT_SELECTOR : selector} {`,
    `  --athlya-brand-primary: ${vars.brandPrimary};`,
    `  --athlya-brand-primary-rgb: ${vars.brandPrimaryRgb};`,
    `  --athlya-brand-on-primary: ${vars.brandOnPrimary};`,
    `  --athlya-brand-primary-tint: ${vars.brandPrimaryTint};`,
    `  --athlya-brand-primary-shade: ${vars.brandPrimaryShade};`,
    `}`,
  ].join('\n');
}

/**
 * Theme object consumed by the Expo app (task 11.1) to override
 * NativeWind's default brand tokens per-tenant. Intentionally a plain
 * value with no React Native imports so it can be constructed on the
 * server or during static evaluation.
 */
export interface RNBrandTheme {
  readonly brand: {
    readonly primary: string;
    readonly onPrimary: string;
    readonly tint: string;
    readonly shade: string;
  };
}

/**
 * Build the React Native brand theme object for a validated brand
 * color.
 *
 * @throws {TypeError} If `brand` is not a valid `#RRGGBB` hex string.
 */
export function buildRNBrandTheme(brand: string): RNBrandTheme {
  const vars = deriveBrandColorVariables(brand);
  return {
    brand: {
      primary: vars.brandPrimary,
      onPrimary: vars.brandOnPrimary,
      tint: vars.brandPrimaryTint,
      shade: vars.brandPrimaryShade,
    },
  };
}

/**
 * WCAG 2.2 AA minimum contrast ratio for "normal" body text against
 * its background. Large text and UI components have a lower bound of
 * 3.0:1, but the brand color is the canvas for arbitrary copy so we
 * gate the strict 4.5:1 threshold.
 *
 * @see https://www.w3.org/TR/WCAG22/#contrast-minimum
 */
export const WCAG_AA_NORMAL_TEXT_RATIO = 4.5;

/**
 * Compute the WCAG 2.2 contrast ratio between two `#RRGGBB` colors.
 *
 * The ratio is `(L1 + 0.05) / (L2 + 0.05)` where `L1 ≥ L2` are the
 * relative luminances of the two colors. The result is symmetric —
 * order of arguments does not matter.
 *
 * @throws {TypeError} If either argument is not a valid `#RRGGBB`
 *   hex color.
 */
export function contrastRatio(a: string, b: string): number {
  const parsedA = parseBrandColor(a);
  const parsedB = parseBrandColor(b);
  if (parsedA === null || parsedB === null) {
    throw new TypeError(
      `contrastRatio expected two #RRGGBB hex colors, received ${JSON.stringify(a)} and ${JSON.stringify(b)}`,
    );
  }
  const [ra, ga, ba] = parseHexChannels(parsedA);
  const [rb, gb, bb] = parseHexChannels(parsedB);
  const la = relativeLuminance(ra, ga, ba);
  const lb = relativeLuminance(rb, gb, bb);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Outcome of {@link evaluateBrandContrast} — the chosen compagnon
 * foreground (`#000000` or `#ffffff`), the resulting contrast ratio
 * and whether it meets the WCAG 2.2 AA minimum for normal text
 * ({@link WCAG_AA_NORMAL_TEXT_RATIO}).
 */
export interface BrandContrastResult {
  /** Pairing chosen by {@link deriveBrandColorVariables}. */
  readonly onPrimary: string;
  /** Achieved contrast ratio against `onPrimary`. */
  readonly ratio: number;
  /** `true` iff `ratio ≥ {@link WCAG_AA_NORMAL_TEXT_RATIO}`. */
  readonly meetsAa: boolean;
}

/**
 * Evaluate the WCAG 2.2 AA contrast of the brand color against its
 * automatically-selected compagnon foreground.
 *
 * Used by the API layer (`PATCH /v1/studios/me`) to refuse a brand
 * color that would render unreadable text. The compagnon choice
 * mirrors {@link deriveBrandColorVariables} so the validation gate
 * sees the same pairing the runtime CSS will emit.
 *
 * @throws {TypeError} If `brand` is not a valid `#RRGGBB` hex string.
 */
export function evaluateBrandContrast(brand: string): BrandContrastResult {
  const vars = deriveBrandColorVariables(brand);
  const ratio = contrastRatio(vars.brandPrimary, vars.brandOnPrimary);
  return {
    onPrimary: vars.brandOnPrimary,
    ratio,
    meetsAa: ratio >= WCAG_AA_NORMAL_TEXT_RATIO,
  };
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

/**
 * Split a validated `#rrggbb` string into its three integer channels.
 * `noUncheckedIndexedAccess` makes the `number` assertion below
 * non-trivial — we prove each slice is well-formed by construction,
 * not by trusting the indexer.
 */
function parseHexChannels(normalised: string): readonly [number, number, number] {
  // `normalised` is guaranteed to match `#rrggbb` at this point.
  const r = Number.parseInt(normalised.slice(1, 3), 16);
  const g = Number.parseInt(normalised.slice(3, 5), 16);
  const b = Number.parseInt(normalised.slice(5, 7), 16);
  return [r, g, b] as const;
}

/** Convert an sRGB channel in `[0, 255]` to its linear-light value. */
function srgbChannelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 2.2 relative luminance on sRGB bytes. */
function relativeLuminance(r: number, g: number, b: number): number {
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

/**
 * Linear interpolation in sRGB from `(r, g, b)` toward
 * `(tr, tg, tb)` by `amount ∈ [0, 1]`. Returns a normalised
 * `#rrggbb` string.
 */
function mixToward(
  r: number,
  g: number,
  b: number,
  tr: number,
  tg: number,
  tb: number,
  amount: number,
): string {
  const mix = (a: number, t: number): number => Math.round(a + (t - a) * amount);
  return `#${toHexByte(mix(r, tr))}${toHexByte(mix(g, tg))}${toHexByte(mix(b, tb))}`;
}

/** Clamp to `[0, 255]` and emit a two-digit lowercase hex byte. */
function toHexByte(n: number): string {
  const clamped = Math.max(0, Math.min(255, n));
  return clamped.toString(16).padStart(2, '0');
}
