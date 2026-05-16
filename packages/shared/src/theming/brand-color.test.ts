/**
 * Unit + property tests for the brand-color theming helpers
 * (task 15.2). Co-located with the implementation because the module
 * is a single self-contained file — running the tests doesn't require
 * any of the larger fixtures shared under `tests/`.
 */

import { fc, it as propIt } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';

import {
    buildBrandColorCss,
    buildRNBrandTheme,
    contrastRatio,
    deriveBrandColorVariables,
    evaluateBrandContrast,
    parseBrandColor,
    WCAG_AA_NORMAL_TEXT_RATIO,
} from './brand-color.js';

/* ------------------------------------------------------------------ */
/*  parseBrandColor                                                    */
/* ------------------------------------------------------------------ */

describe('parseBrandColor', () => {
    it('normalises a valid uppercase hex to lowercase', () => {
        expect(parseBrandColor('#0EA5E9')).toBe('#0ea5e9');
    });

    it('accepts a lowercase hex unchanged', () => {
        expect(parseBrandColor('#0ea5e9')).toBe('#0ea5e9');
    });

    it('accepts a mixed-case hex', () => {
        expect(parseBrandColor('#aAbBcC')).toBe('#aabbcc');
    });

    it.each([
        ['5-digit form', '#0ea5e'],
        ['missing hash', '0EA5E9'],
        ['non-hex character', '#ffg000'],
        ['8-digit rgba form', '#0ea5e9ff'],
        ['3-digit short form', '#fff'],
        ['empty string', ''],
        ['whitespace only', '   '],
        ['hash only', '#'],
        ['wrapping spaces', ' #0EA5E9 '],
    ])('rejects %s', (_label, raw) => {
        expect(parseBrandColor(raw)).toBeNull();
    });
});

/* ------------------------------------------------------------------ */
/*  deriveBrandColorVariables — contrast pairing                       */
/* ------------------------------------------------------------------ */

describe('deriveBrandColorVariables — contrast pairing', () => {
    it('pairs a bright brand with black text (#0EA5E9 — sky blue)', () => {
        // Luminance lands well above the ~0.179 crossover, so the
        // dark foreground is the readable choice on top.
        const vars = deriveBrandColorVariables('#0EA5E9');
        expect(vars.brandPrimary).toBe('#0ea5e9');
        expect(vars.brandOnPrimary).toBe('#000000');
    });

    it('pairs a near-black brand with white text (#1a1a2e)', () => {
        const vars = deriveBrandColorVariables('#1a1a2e');
        expect(vars.brandOnPrimary).toBe('#ffffff');
    });

    it('pairs pure white with black text', () => {
        expect(deriveBrandColorVariables('#ffffff').brandOnPrimary).toBe('#000000');
    });

    it('pairs pure black with white text', () => {
        expect(deriveBrandColorVariables('#000000').brandOnPrimary).toBe('#ffffff');
    });
});

/* ------------------------------------------------------------------ */
/*  deriveBrandColorVariables — tokens                                 */
/* ------------------------------------------------------------------ */

describe('deriveBrandColorVariables — tokens', () => {
    const vars = deriveBrandColorVariables('#0EA5E9');

    it('exposes the raw color as brandPrimary', () => {
        expect(vars.brandPrimary).toBe('#0ea5e9');
    });

    it('emits brandPrimaryRgb as "r, g, b" decimals', () => {
        expect(vars.brandPrimaryRgb).toBe('14, 165, 233');
    });

    it('produces a tint that is a distinct valid #rrggbb and lighter than the base', () => {
        expect(vars.brandPrimaryTint).toMatch(/^#[0-9a-f]{6}$/u);
        expect(vars.brandPrimaryTint).not.toBe(vars.brandPrimary);
        // 15% toward white must increase each channel.
        const channel = (hex: string, offset: number): number =>
            Number.parseInt(hex.slice(1 + offset, 3 + offset), 16);
        expect(channel(vars.brandPrimaryTint, 0)).toBeGreaterThanOrEqual(
            channel(vars.brandPrimary, 0),
        );
        expect(channel(vars.brandPrimaryTint, 2)).toBeGreaterThanOrEqual(
            channel(vars.brandPrimary, 2),
        );
        expect(channel(vars.brandPrimaryTint, 4)).toBeGreaterThanOrEqual(
            channel(vars.brandPrimary, 4),
        );
    });

    it('produces a shade that is a distinct valid #rrggbb and darker than the base', () => {
        expect(vars.brandPrimaryShade).toMatch(/^#[0-9a-f]{6}$/u);
        expect(vars.brandPrimaryShade).not.toBe(vars.brandPrimary);
        const channel = (hex: string, offset: number): number =>
            Number.parseInt(hex.slice(1 + offset, 3 + offset), 16);
        expect(channel(vars.brandPrimaryShade, 0)).toBeLessThanOrEqual(
            channel(vars.brandPrimary, 0),
        );
        expect(channel(vars.brandPrimaryShade, 2)).toBeLessThanOrEqual(
            channel(vars.brandPrimary, 2),
        );
        expect(channel(vars.brandPrimaryShade, 4)).toBeLessThanOrEqual(
            channel(vars.brandPrimary, 4),
        );
    });

    it('throws on an invalid hex', () => {
        expect(() => deriveBrandColorVariables('not-a-color')).toThrow(TypeError);
    });
});

/* ------------------------------------------------------------------ */
/*  buildBrandColorCss                                                 */
/* ------------------------------------------------------------------ */

describe('buildBrandColorCss', () => {
    it('emits all five --athlya-brand-* custom properties under :root by default', () => {
        const css = buildBrandColorCss('#0EA5E9');
        expect(css).toContain(':root {');
        expect(css).toContain('--athlya-brand-primary: #0ea5e9;');
        expect(css).toContain('--athlya-brand-primary-rgb: 14, 165, 233;');
        expect(css).toContain('--athlya-brand-on-primary: #000000;');
        expect(css).toMatch(/--athlya-brand-primary-tint: #[0-9a-f]{6};/u);
        expect(css).toMatch(/--athlya-brand-primary-shade: #[0-9a-f]{6};/u);
        expect(css.trim().endsWith('}')).toBe(true);
    });

    it('honours a custom selector', () => {
        const css = buildBrandColorCss('#1a1a2e', '[data-studio="acme"]');
        expect(css.startsWith('[data-studio="acme"] {')).toBe(true);
        expect(css).toContain('--athlya-brand-on-primary: #ffffff;');
    });

    it('throws on an invalid hex', () => {
        expect(() => buildBrandColorCss('#xyz')).toThrow(TypeError);
    });
});

/* ------------------------------------------------------------------ */
/*  buildRNBrandTheme                                                  */
/* ------------------------------------------------------------------ */

describe('buildRNBrandTheme', () => {
    it('mirrors the four brand fields without RN imports', () => {
        const theme = buildRNBrandTheme('#0EA5E9');
        expect(theme.brand.primary).toBe('#0ea5e9');
        expect(theme.brand.onPrimary).toBe('#000000');
        expect(theme.brand.tint).toMatch(/^#[0-9a-f]{6}$/u);
        expect(theme.brand.shade).toMatch(/^#[0-9a-f]{6}$/u);
    });

    it('throws on an invalid hex', () => {
        expect(() => buildRNBrandTheme('nope')).toThrow(TypeError);
    });
});

/* ------------------------------------------------------------------ */
/*  evaluateBrandContrast — WCAG AA gate (slice B9.2)                   */
/* ------------------------------------------------------------------ */

describe('evaluateBrandContrast', () => {
    it('passes for a high-contrast brand (#0EA5E9 sky blue, ~7.7:1 vs black)', () => {
        const result = evaluateBrandContrast('#0EA5E9');
        expect(result.onPrimary).toBe('#000000');
        expect(result.ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_RATIO);
        expect(result.meetsAa).toBe(true);
    });

    it('passes for a near-black brand against white text', () => {
        const result = evaluateBrandContrast('#1a1a2e');
        expect(result.onPrimary).toBe('#ffffff');
        expect(result.meetsAa).toBe(true);
    });

    it('passes for a mid-grey via the auto-paired companion (gate is defense-in-depth)', () => {
        // The auto-pair logic in `deriveBrandColorVariables` always
        // picks the compagnon with the better contrast, so any valid
        // `#RRGGBB` hex hits ≥ 4.58:1 by construction. The gate exists
        // to defend against accidental drift in the helper (and to
        // surface a structured 422 if a future tweak ever lowers the
        // crossover).
        const result = evaluateBrandContrast('#A0A0A0');
        expect(result.onPrimary).toBe('#000000');
        expect(result.meetsAa).toBe(true);
    });

    it('throws on invalid hex', () => {
        expect(() => evaluateBrandContrast('#xyz')).toThrow(TypeError);
    });
});

/* ------------------------------------------------------------------ */
/*  contrastRatio                                                      */
/* ------------------------------------------------------------------ */

describe('contrastRatio', () => {
    it('returns 21 for black vs white (the maximum)', () => {
        expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
    });

    it('is symmetric (a vs b == b vs a)', () => {
        const ab = contrastRatio('#0EA5E9', '#000000');
        const ba = contrastRatio('#000000', '#0EA5E9');
        expect(ab).toBeCloseTo(ba, 5);
    });

    it('returns 1 for identical colors', () => {
        expect(contrastRatio('#abcdef', '#ABCDEF')).toBeCloseTo(1, 5);
    });

    it('throws on invalid hex inputs', () => {
        expect(() => contrastRatio('#xyz', '#000000')).toThrow(TypeError);
        expect(() => contrastRatio('#000000', '!')).toThrow(TypeError);
    });
});

/* ------------------------------------------------------------------ */
/*  Property test                                                      */
/* ------------------------------------------------------------------ */

/**
 * Generator of arbitrary valid `#RRGGBB` hex strings. Built from raw
 * bytes so we cover the full color space, then stringified with the
 * same `#rrggbb` casing the parser normalises to.
 */
const hexColorArb = fc
    .tuple(fc.nat({ max: 255 }), fc.nat({ max: 255 }), fc.nat({ max: 255 }))
    .map(
        ([r, g, b]) =>
            `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b
                .toString(16)
                .padStart(2, '0')}`,
    );

describe('property: deriveBrandColorVariables', () => {
    propIt.prop([hexColorArb], { numRuns: 50 })(
        'every valid hex yields five well-formed tokens',
        (hex) => {
            expect(parseBrandColor(hex)).not.toBeNull();
            const vars = deriveBrandColorVariables(hex);
            expect(vars.brandPrimary).toMatch(/^#[0-9a-f]{6}$/u);
            expect(vars.brandOnPrimary).toMatch(/^#[0-9a-f]{6}$/u);
            expect(vars.brandPrimaryTint).toMatch(/^#[0-9a-f]{6}$/u);
            expect(vars.brandPrimaryShade).toMatch(/^#[0-9a-f]{6}$/u);
            expect(vars.brandPrimaryRgb).toMatch(/^\d+, \d+, \d+$/u);
            // Invariant: `brandOnPrimary` is one of the two contrast
            // endpoints — there is no third option.
            expect(['#000000', '#ffffff']).toContain(vars.brandOnPrimary);
        },
    );
});
