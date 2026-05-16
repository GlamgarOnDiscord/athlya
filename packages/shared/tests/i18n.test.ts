/**
 * Unit tests for the `@athlya/shared/i18n` helper.
 *
 * The helper promises three runtime behaviours (see `src/i18n/index.ts`):
 *
 *   1. When the key resolves in the requested locale, return that value.
 *   2. When the key is missing in the requested locale, fall back to the
 *      English bundle (Requirement 28.1 — English is the guaranteed
 *      fallback for every user-facing string).
 *   3. When the key is missing in *both* bundles, return the key itself
 *      so the UI never crashes on a typo, and `console.warn` once per
 *      lookup in non-production builds.
 *
 * Fallback testing strategy (see task 1.6 design notes):
 *   Every MVP key currently exists in both `fr` and `en`, so the runtime
 *   fallback path is never triggered in production. To exercise the
 *   fallback contract we temporarily delete one leaf from the in-memory
 *   `bundles.fr` object inside a dedicated `describe` block, restore it
 *   in `afterEach`, and assert the EN value surfaces. This is the same
 *   trick the original task-1.6 author reached for; it is safe because
 *   Node's JSON import returns a plain, mutable `Record<string,
 *   unknown>` (the outer `bundles` binding is `as const`, but the inner
 *   bundle objects are not frozen). No schema or i18n source file is
 *   modified — mutation happens entirely inside the test.
 *
 * Related requirements: 28.1.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import {
    bundles,
    createTranslator,
    defaultLocale,
    fallbackLocale,
    t,
    type TranslationKeys,
} from '../src/i18n/index.js';

/* ------------------------------------------------------------------ */
/*  Local helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Walk a dotted path inside a bundle and temporarily delete the leaf.
 * Returns a restore function so each test repairs the bundle in its
 * `afterEach` hook — otherwise the mutation would leak into sibling tests.
 */
function deleteLeaf(bundle: unknown, path: readonly string[]): () => void {
    if (path.length === 0) throw new Error('empty path');
    let cursor = bundle as Record<string, unknown>;
    for (let i = 0; i < path.length - 1; i++) {
        const segment = path[i] as string;
        const next = cursor[segment];
        if (next === null || typeof next !== 'object') {
            throw new Error(`path ${path.join('.')} missing at segment ${segment}`);
        }
        cursor = next as Record<string, unknown>;
    }
    const leafKey = path[path.length - 1] as string;
    const original = cursor[leafKey];
    delete cursor[leafKey];
    return () => {
        cursor[leafKey] = original;
    };
}

/**
 * Recursively collect every dotted leaf-path of a nested translation
 * object. Used by the consistency test to assert the two bundles have
 * matching structure.
 */
function collectKeys(bundle: unknown, prefix = ''): string[] {
    if (bundle === null || typeof bundle !== 'object') return [];
    const out: string[] = [];
    for (const [key, value] of Object.entries(bundle as Record<string, unknown>)) {
        const path = prefix === '' ? key : `${prefix}.${key}`;
        if (typeof value === 'string') {
            out.push(path);
        } else if (value !== null && typeof value === 'object') {
            out.push(...collectKeys(value, path));
        }
    }
    return out;
}

/* ------------------------------------------------------------------ */
/*  Configuration sanity                                               */
/* ------------------------------------------------------------------ */

describe('i18n configuration', () => {
    it('defaults to French and falls back to English', () => {
        expect(defaultLocale).toBe('fr');
        expect(fallbackLocale).toBe('en');
    });

    it('exposes fr and en bundles', () => {
        expect(typeof bundles.fr).toBe('object');
        expect(typeof bundles.en).toBe('object');
    });
});

/* ------------------------------------------------------------------ */
/*  Resolution — happy path                                            */
/* ------------------------------------------------------------------ */

describe('t(key, locale) — resolution', () => {
    it('returns the French string when locale=fr', () => {
        expect(t('auth.login.submit', 'fr')).toBe('Se connecter');
    });

    it('returns the English string when locale=en', () => {
        expect(t('auth.login.submit', 'en')).toBe('Sign in');
    });

    it('uses the default locale (fr) when none is provided', () => {
        expect(t('common.save')).toBe('Enregistrer');
    });

    it('resolves a 3-level-deep nested key (rgpd.export.request)', () => {
        expect(t('rgpd.export.request', 'fr')).toBe('Exporter mes données');
        expect(t('rgpd.export.request', 'en')).toBe('Export my data');
    });

    it('resolves template-style keys without interpreting placeholders', () => {
        // The helper does not do interpolation — that's the caller's job —
        // so the `{position}` marker must come back verbatim.
        expect(t('reservations.waitlistPosition', 'fr')).toContain('{position}');
        expect(t('reservations.waitlistPosition', 'en')).toContain('{position}');
    });
});

describe('createTranslator(locale)', () => {
    it('returns a function bound to the given locale (en)', () => {
        const tr = createTranslator('en');
        expect(tr('auth.login.submit')).toBe('Sign in');
        expect(tr('common.cancel')).toBe('Cancel');
    });

    it('returns a function bound to the given locale (fr)', () => {
        const tr = createTranslator('fr');
        expect(tr('auth.login.submit')).toBe('Se connecter');
    });
});

/* ------------------------------------------------------------------ */
/*  Fallback behaviour — Requirement 28.1                              */
/* ------------------------------------------------------------------ */

describe('t(key, locale) — English fallback (Req 28.1)', () => {
    // `common.save` exists in both bundles in production. We delete the
    // FR leaf for the duration of each test in this block so the fallback
    // branch is actually exercised.
    const MISSING_KEY: TranslationKeys = 'common.save';
    const MISSING_PATH = ['common', 'save'] as const;

    let restore: () => void = () => undefined;
    let warnSpy: MockInstance;

    beforeEach(() => {
        restore = deleteLeaf(bundles.fr, MISSING_PATH);
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        restore();
        warnSpy.mockRestore();
    });

    it('returns the English string when the key is missing in FR', () => {
        expect(t(MISSING_KEY, 'fr')).toBe('Save');
    });

    it('warns in non-production when falling back to en', () => {
        t(MISSING_KEY, 'fr');
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const firstCall = warnSpy.mock.calls[0];
        expect(firstCall).toBeDefined();
        const [msg] = firstCall as [unknown];
        expect(typeof msg).toBe('string');
        expect(msg as string).toContain('Missing');
        expect(msg as string).toContain(MISSING_KEY);
    });

    it('falls back through createTranslator(fr) too', () => {
        const tr = createTranslator('fr');
        expect(tr(MISSING_KEY)).toBe('Save');
    });
});

describe('t(key, locale) — key missing in every bundle', () => {
    // Cast-through-unknown to bypass the compile-time key check — the
    // runtime contract accepts any string and returns it verbatim.
    const BOGUS = 'this.key.does.not.exist' as unknown as TranslationKeys;
    let warnSpy: MockInstance;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    it('returns the key itself when absent from both bundles', () => {
        expect(t(BOGUS, 'fr')).toBe(BOGUS);
        expect(t(BOGUS, 'en')).toBe(BOGUS);
    });

    it('warns with "returning key as-is" when no bundle resolves the key', () => {
        t(BOGUS, 'fr');
        expect(warnSpy).toHaveBeenCalled();
        const firstCall = warnSpy.mock.calls[0];
        expect(firstCall).toBeDefined();
        const [msg] = firstCall as [unknown];
        expect(typeof msg).toBe('string');
        expect(msg as string).toContain('returning key as-is');
    });
});

/* ------------------------------------------------------------------ */
/*  Bundle parity — structural consistency                             */
/* ------------------------------------------------------------------ */

describe('bundles.fr and bundles.en structural parity', () => {
    it('has identical top-level keys', () => {
        const frKeys = Object.keys(bundles.fr).sort();
        const enKeys = Object.keys(bundles.en).sort();
        expect(frKeys).toEqual(enKeys);
    });

    it('has identical leaf-paths (so no real fallback is ever triggered in prod)', () => {
        const frLeaves = collectKeys(bundles.fr).sort();
        const enLeaves = collectKeys(bundles.en).sort();
        expect(frLeaves).toEqual(enLeaves);
    });
});

/* ------------------------------------------------------------------ */
/*  Placeholder interpolation                                          */
/* ------------------------------------------------------------------ */

describe('t(key, locale, values) — placeholder interpolation', () => {
    it('replaces {name} markers with the provided values', () => {
        expect(
            t('reservations.waitlistPosition', 'fr', { position: 3 }),
        ).toBe("Position sur la liste d'attente : 3");
        expect(
            t('reservations.waitlistPosition', 'en', { position: 3 }),
        ).toBe('Waitlist position: 3');
    });

    it('coerces numeric, boolean and bigint values through String()', () => {
        // `{seconds}` appears once in the bundle; running the helper on
        // different primitive types documents the coercion contract for
        // downstream adapters (notifications, error pages, etc.).
        expect(t('checkin.qrExpiresIn', 'fr', { seconds: 60 })).toContain('60');
        expect(t('checkin.qrExpiresIn', 'en', { seconds: 60n })).toContain('60');
        expect(t('checkin.qrExpiresIn', 'en', { seconds: true })).toContain('true');
    });

    it('coerces null and undefined to an empty string', () => {
        expect(
            t('reservations.waitlistPosition', 'fr', { position: null }),
        ).toBe("Position sur la liste d'attente : ");
        expect(
            t('reservations.waitlistPosition', 'fr', { position: undefined }),
        ).toBe("Position sur la liste d'attente : ");
    });

    it('leaves markers untouched when the key is missing from values', () => {
        // No `position` key in the values bag — the marker survives so
        // tooling can surface the gap.
        expect(
            t('reservations.waitlistPosition', 'fr', { other: 'ignored' }),
        ).toContain('{position}');
    });

    it('works through createTranslator(locale)', () => {
        const tr = createTranslator('en');
        expect(tr('reservations.waitlistPosition', { position: 7 })).toBe(
            'Waitlist position: 7',
        );
    });

    it('interpolates into the English fallback when the FR leaf is missing', () => {
        // Reuse the same deletion trick used by the fallback tests: drop
        // `reservations.waitlistPosition` from the FR bundle, ensure the
        // helper falls back to EN and still interpolates.
        const restore = deleteLeaf(bundles.fr, [
            'reservations',
            'waitlistPosition',
        ]);
        const warnSpy = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined);
        try {
            expect(
                t('reservations.waitlistPosition', 'fr', { position: 2 }),
            ).toBe('Waitlist position: 2');
        } finally {
            warnSpy.mockRestore();
            restore();
        }
    });
});
