import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { deriveBrandColorVariables } from '../src/theming/brand-color';
import { buildThemeCss } from '../src/theming/theme-css';
import { colors, tokens } from '../src/tokens';

const THEME_CSS = fileURLToPath(new URL('../src/styles/theme.css', import.meta.url));

function build(): string {
  return buildThemeCss(tokens, deriveBrandColorVariables(colors.light.primary));
}

describe('shared theme stylesheet', () => {
  it('is in sync with the tokens (run `pnpm --filter @athlya/shared run build:theme-css`)', () => {
    expect(readFileSync(THEME_CSS, 'utf8')).toBe(build());
  });

  it('declares every semantic colour for both themes', () => {
    const css = build();
    for (const key of Object.keys(colors.light)) {
      const name = key.replace(/[A-Z]/gu, (l) => `-${l.toLowerCase()}`);
      expect(css).toContain(
        `--color-light-${name}: ${colors.light[key as keyof typeof colors.light].toLowerCase()};`,
      );
      expect(css).toContain(
        `--color-dark-${name}: ${colors.dark[key as keyof typeof colors.dark].toLowerCase()};`,
      );
      expect(css).toContain(`--color-${name}: var(--color-dark-${name});`);
    }
  });

  it('switches on the next-themes class and falls back to the OS preference', () => {
    const css = build();
    expect(css).toContain(':root.dark {');
    expect(css).toContain('@media (prefers-color-scheme: dark) {\n  :root:not(.light) {');
    expect(css).toContain('&:where(.dark, .dark *)');
  });

  it('maps the Tailwind spacing base and type scale onto the tokens', () => {
    const css = build();
    expect(css).toContain('--spacing: var(--spacing-xs);');
    expect(css).toContain('--text-base: var(--font-size-base);');
  });
});
