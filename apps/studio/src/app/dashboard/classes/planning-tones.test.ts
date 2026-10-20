/**
 * WCAG 2.2 AA contrast of the planning tile text on every pastel tone and
 * on the full-class fill, in both themes, read from the tokens in
 * `globals.css` so a colour change that breaks a pair fails CI.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PLANNING_TONES } from './planning-grid';

const css = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries(
    [...body.matchAll(/--(planning-[a-z-]+):\s*(#[0-9a-f]{6});/gu)].map((m) => [m[1], m[2]]),
  );
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const themes = { light: block(':root'), dark: block(':root.dark') };

describe.each(Object.entries(themes))('planning tiles (%s)', (_, tokens) => {
  const fills = [...PLANNING_TONES, 'full'];

  it.each(fills)('ink and muted text pass AA on %s', (tone) => {
    const fill = tokens[`planning-${tone}`] ?? '';
    expect(fill).not.toBe('');
    expect(contrast(tokens[`planning-${tone}-ink`] ?? '', fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens['planning-tile-muted'] ?? '', fill)).toBeGreaterThanOrEqual(4.5);
  });

  it('pill text passes AA on the pill', () => {
    expect(
      contrast(tokens['planning-pill-fg'] ?? '', tokens['planning-pill-bg'] ?? ''),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

it('defines the same planning tokens for dark mode in the media query', () => {
  const media = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
  expect(block(':root.dark')).toEqual(
    Object.fromEntries(
      [
        ...media.slice(0, media.indexOf('}')).matchAll(/--(planning-[a-z-]+):\s*(#[0-9a-f]{6});/gu),
      ].map((m) => [m[1], m[2]]),
    ),
  );
});
