/**
 * Unit tests for the inlined `Accept-Language` negotiation helper.
 *
 * Mirrors the four contract cases called out in the task brief:
 *  - exact match
 *  - primary-language prefix match (`fr-CA` → `fr`)
 *  - unsupported tag falls back to the caller default
 *  - empty / null / wildcard input falls back to the caller default
 *
 * The canonical implementation lives at
 * `packages/api/src/i18n/negotiate.ts`; see its test file for the full
 * RFC 4647 matrix. This test file only covers the contract surface
 * exposed to the web app.
 *
 * @see Req 28.2 — locale selection from Accept-Language.
 */
import { describe, expect, it } from 'vitest';

import { negotiateLocale } from './negotiate';

const SUPPORTED = ['fr', 'en'] as const;
const FALLBACK = 'fr';

describe('negotiateLocale (web)', () => {
    it('returns the exact match when a supported tag is listed', () => {
        expect(negotiateLocale('en', SUPPORTED, FALLBACK)).toBe('en');
    });

    it('falls back to the primary language subtag (fr-CA → fr)', () => {
        // `fr-CA` is not in SUPPORTED but its primary language `fr` is.
        expect(negotiateLocale('fr-CA', SUPPORTED, FALLBACK)).toBe('fr');
    });

    it('returns the fallback when no supported tag is listed', () => {
        expect(negotiateLocale('de,es;q=0.9', SUPPORTED, FALLBACK)).toBe('fr');
    });

    it('returns the fallback for null / empty / wildcard headers', () => {
        expect(negotiateLocale(null, SUPPORTED, FALLBACK)).toBe('fr');
        expect(negotiateLocale(undefined, SUPPORTED, FALLBACK)).toBe('fr');
        expect(negotiateLocale('', SUPPORTED, FALLBACK)).toBe('fr');
        expect(negotiateLocale('*', SUPPORTED, FALLBACK)).toBe('fr');
    });
});
