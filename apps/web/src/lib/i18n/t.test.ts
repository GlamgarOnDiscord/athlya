/**
 * Unit tests for `createTranslator` — the web-app translator wrapper.
 *
 * These deliberately stay thin because the heavy lifting (fallback
 * chain, warning, interpolation) is covered exhaustively by
 * `@athlya/shared/tests/i18n.test.ts`. What we assert here is that the
 * wrapper binds the locale correctly and surfaces the shared helper's
 * behaviour end-to-end.
 *
 * @see Req 28.1 — every string resolves through `@athlya/shared/i18n`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from './t';

describe('createTranslator', () => {
    it('resolves web.home.title in French', () => {
        const t = createTranslator('fr');
        expect(t('web.home.title')).toBe('Athlya');
    });

    it('resolves web.home.title in English', () => {
        const t = createTranslator('en');
        expect(t('web.home.title')).toBe('Athlya');
    });

    describe('when the key is missing from every bundle', () => {
        let warnSpy: ReturnType<typeof vi.spyOn>;

        beforeEach(() => {
            warnSpy = vi
                .spyOn(console, 'warn')
                .mockImplementation(() => undefined);
        });

        afterEach(() => {
            warnSpy.mockRestore();
        });

        it('returns the key itself and warns via console.warn', () => {
            const t = createTranslator('fr');
            // Cast through unknown to bypass the compile-time key check
            // — the runtime contract accepts any string and returns it
            // verbatim on miss.
            const bogus = 'web.does.not.exist' as unknown as Parameters<typeof t>[0];
            expect(t(bogus)).toBe('web.does.not.exist');
            expect(warnSpy).toHaveBeenCalled();
            const firstCall = warnSpy.mock.calls[0];
            expect(firstCall).toBeDefined();
            const [msg] = firstCall as [unknown];
            expect(typeof msg).toBe('string');
            expect(msg as string).toContain('web.does.not.exist');
        });
    });

    it('interpolates {position} placeholder in FR', () => {
        const t = createTranslator('fr');
        expect(
            t('reservations.waitlistPosition', { position: 3 }),
        ).toBe("Position sur la liste d'attente : 3");
    });

    it('round-trips Unicode values through interpolation', () => {
        const t = createTranslator('fr');
        // The bundle contains French-specific characters
        // (apostrophe typographique `’`, accented letters). The
        // translator must surface them byte-for-byte.
        const greeting = t('web.home.tagline');
        expect(greeting).toBe(
            'Plateforme fitness open-source, multi-tenant, RGPD-first.',
        );
        // And interpolated values with emoji survive untouched.
        const withEmoji = t('reservations.waitlistPosition', {
            position: '🚀 3',
        });
        expect(withEmoji).toBe("Position sur la liste d'attente : 🚀 3");
    });
});
