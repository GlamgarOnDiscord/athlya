/**
 * Build-time generator for `apps/web/src/styles/tokens.css`.
 *
 * Reads the typed tokens from `src/tokens.ts`, serializes them into
 * CSS custom properties, and overwrites the target CSS file. Idempotent:
 * running it twice on the same source produces the same byte-for-byte
 * output — CI can assert "tokens.css is in sync" by re-running the
 * generator and comparing against the committed file.
 *
 * Runs via `pnpm --filter @athlya/shared run build:tokens-css` on Node 22+
 * which supports `--experimental-strip-types` to execute TS directly.
 *
 * The generator imports `tokens.ts` via a RELATIVE .ts import inline
 * (single-file script) rather than going through a sibling module.
 * Node's `--experimental-strip-types` resolves `./tokens.ts` but not
 * the bare `.js` Drizzle-style imports that the ESM package uses at
 * runtime, so we duplicate the lightweight token data here instead.
 * That data stays perfectly in sync because the typecheck below asserts
 * `TokensCheck = typeof tokens` — any drift between `tokens.ts` and
 * this script fails `pnpm --filter @athlya/shared typecheck`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line import/no-unresolved -- Node's strip-types loader
// resolves .ts sibling imports at runtime; TypeScript happily follows them
// because `moduleResolution: "bundler"` accepts .ts suffixes.
import { colors, radii, shadows, spacing, typography } from '../src/tokens.ts';

const DEFAULT_TARGET = '../../../apps/web/src/styles/tokens.css';

/** `camelCase` → `kebab-case`. */
function camelToKebab(key: string): string {
    return key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function serializeColorBlock(
    prefix: 'light' | 'dark',
    scheme: Record<string, string>,
    indent: string,
): string {
    return Object.entries(scheme)
        .map(([k, v]) => `${indent}--color-${prefix}-${camelToKebab(k)}: ${v};`)
        .join('\n');
}

function serializeActiveAliases(indent: string): string {
    return Object.keys(colors.light)
        .map((k) => {
            const name = camelToKebab(k);
            return `${indent}--color-${name}: var(--color-light-${name});`;
        })
        .join('\n');
}

function serializeDarkOverrides(indent: string): string {
    return Object.keys(colors.dark)
        .map((k) => {
            const name = camelToKebab(k);
            return `${indent}--color-${name}: var(--color-dark-${name});`;
        })
        .join('\n');
}

function serializeFlat(
    prefix: string,
    record: Record<string, string | number>,
    indent: string,
): string {
    return Object.entries(record)
        .map(([k, v]) => `${indent}--${prefix}-${camelToKebab(k)}: ${v};`)
        .join('\n');
}

function generateTokensCss(): string {
    const I = '    ';
    const lines: string[] = [
        '/*',
        ' * Athlya design tokens exposed as CSS custom properties.',
        ' *',
        ' * GENERATED FILE — do not edit by hand.',
        ' * Source of truth: packages/shared/src/tokens.ts',
        ' * Generator:       packages/shared/scripts/generate-tokens-css.ts',
        ' *',
        ' * Regenerate with: pnpm --filter @athlya/shared run build:tokens-css',
        ' */',
        '',
        ':root {',
        `${I}/* Light theme semantic colors — @athlya/shared/tokens -> colors.light */`,
        serializeColorBlock('light', colors.light, I),
        '',
        `${I}/* Dark theme semantic colors — @athlya/shared/tokens -> colors.dark */`,
        serializeColorBlock('dark', colors.dark, I),
        '',
        `${I}/* Active semantic colors resolve to the light theme by default. */`,
        serializeActiveAliases(I),
        '',
        `${I}/* Spacing — tokens.ts -> spacing */`,
        serializeFlat('spacing', spacing, I),
        '',
        `${I}/* Typography — tokens.ts -> typography.fontFamily */`,
        `${I}--font-family-sans: ${typography.fontFamily.sans};`,
        `${I}--font-family-mono: ${typography.fontFamily.mono};`,
        '',
        `${I}/* Typography — tokens.ts -> typography.fontSize */`,
        serializeFlat('font-size', typography.fontSize, I),
        '',
        `${I}/* Typography — tokens.ts -> typography.fontWeight */`,
        serializeFlat('font-weight', typography.fontWeight, I),
        '',
        `${I}/* Typography — tokens.ts -> typography.lineHeight */`,
        serializeFlat('line-height', typography.lineHeight, I),
        '',
        `${I}/* Radii — tokens.ts -> radii */`,
        serializeFlat('radius', radii, I),
        '',
        `${I}/* Shadows — tokens.ts -> shadows */`,
        serializeFlat('shadow', shadows, I),
        '',
        `${I}/* Per-tenant brand color — overridden server-side by`,
        `${I}   buildBrandColorCss (Epic 15.2). Default = Athlya primary. */`,
        `${I}--athlya-brand-primary: ${colors.light.primary};`,
        `${I}--athlya-brand-primary-rgb: 14, 165, 233;`,
        `${I}--athlya-brand-on-primary: ${colors.light.primaryForeground};`,
        `${I}--athlya-brand-primary-tint: #27aceb;`,
        `${I}--athlya-brand-primary-shade: #0c8cc6;`,
        '}',
        '',
        '@media (prefers-color-scheme: dark) {',
        `${I}:root {`,
        serializeDarkOverrides(`${I}${I}`),
        `${I}}`,
        '}',
        '',
    ];
    return lines.join('\n');
}

function main(): void {
    const here = dirname(fileURLToPath(import.meta.url));
    const target = resolve(here, process.env['OUT'] ?? DEFAULT_TARGET);
    const css = generateTokensCss();
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, css, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[generate-tokens-css] wrote ${target} (${css.length} bytes)`);
}

main();
