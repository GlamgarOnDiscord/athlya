/**
 * Unit tests for the `Accept-Language` negotiation helper.
 *
 * Covers the Requirement 28.2 acceptance cases called out by task
 * 19.1:
 *
 *   • Exact match, quality-weighted match, and language-prefix
 *     match (`fr-CA` → `fr`).
 *   • Case-insensitive tag comparison.
 *   • Explicit `q=0` means "not acceptable" and must be skipped.
 *   • Lenient recovery from malformed `q=` values.
 *   • Fallback on `null` / `undefined` / empty string / `*` /
 *     all-malformed headers.
 *   • `options.supported` and `options.default` overrides.
 *   • `formatProblemDetailLocale('fr')` → `'Locale: fr'`.
 */

import { describe, expect, it } from 'vitest';

import {
    DEFAULT_LOCALE,
    SUPPORTED_LOCALES,
    formatProblemDetailLocale,
    negotiateLocale,
} from '../i18n/negotiate.js';

describe('negotiateLocale', () => {
    it('exposes the expected supported-locale tuple and default', () => {
        // Sanity check: the Locale type and the default are derived
        // from SUPPORTED_LOCALES, so any accidental drift would cause
        // widespread compile errors. This pins the runtime values too.
        expect([...SUPPORTED_LOCALES]).toEqual(['fr', 'en']);
        expect(DEFAULT_LOCALE).toBe('fr');
    });

    it('selects the exact match for a single-tag header', () => {
        expect(negotiateLocale('fr')).toBe('fr');
    });

    it('honours quality ordering in multi-tag headers', () => {
        // en-US (q=1) > en (q=0.9) > fr (q=0.5) → 'en' wins once
        // en-US falls back via prefix to 'en'.
        expect(negotiateLocale('en-US,en;q=0.9,fr;q=0.5')).toBe('en');
    });

    it('falls back to the default when no tag matches the supported set', () => {
        expect(negotiateLocale('de,es;q=0.9')).toBe('fr');
    });

    it('falls back to the default on null input', () => {
        expect(negotiateLocale(null)).toBe('fr');
    });

    it('falls back to the default on undefined input', () => {
        expect(negotiateLocale(undefined)).toBe('fr');
    });

    it('falls back to the default on an empty string', () => {
        expect(negotiateLocale('')).toBe('fr');
    });

    it('falls back to the default on a wildcard-only header', () => {
        expect(negotiateLocale('*')).toBe('fr');
    });

    it('is lenient about malformed q values and keeps the tag', () => {
        // `q=abc` is not a number; the tag is still acceptable. The
        // parser recovers by defaulting q=1 rather than dropping the
        // entry.
        expect(negotiateLocale('fr;q=abc')).toBe('fr');
    });

    it('falls back when the header has zero acceptable tags', () => {
        // Three empty segments — no tag survives parsing.
        expect(negotiateLocale(';;;')).toBe('fr');
    });

    it('matches tags case-insensitively', () => {
        expect(negotiateLocale('FR')).toBe('fr');
    });

    it('prefers the highest-q tag regardless of source order', () => {
        // en listed first but with q=0.1; fr wins on quality.
        expect(negotiateLocale('en;q=0.1,fr;q=0.9')).toBe('fr');
    });

    it('matches by primary language subtag when no exact match exists', () => {
        // Only `fr` and `en` are supported; `fr-CA` must fall back to
        // its primary language `fr`.
        expect(negotiateLocale('fr-CA')).toBe('fr');
    });

    it('treats explicit q=0 as "not acceptable" and skips the tag', () => {
        // `fr` is rejected by the client, `en` is preferred, so `en`
        // must win even though it is listed second.
        expect(negotiateLocale('fr;q=0,en;q=1')).toBe('en');
    });

    it('honours options.supported and options.default overrides', () => {
        // `de` is not in the MVP supported set, but the caller can
        // widen the list and pick a different default.
        const result = negotiateLocale('de', {
            supported: ['de', 'en'],
            default: 'en',
        });
        expect(result).toBe('de');
    });

    it('uses options.default when no supported tag is listed', () => {
        const result = negotiateLocale('ru', {
            supported: ['de', 'en'],
            default: 'en',
        });
        expect(result).toBe('en');
    });
});

describe('formatProblemDetailLocale', () => {
    it('renders the Problem Details locale fragment for fr', () => {
        expect(formatProblemDetailLocale('fr')).toBe('Locale: fr');
    });

    it('renders the Problem Details locale fragment for en', () => {
        expect(formatProblemDetailLocale('en')).toBe('Locale: en');
    });
});
