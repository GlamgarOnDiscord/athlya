/**
 * Writes `src/styles/theme.css` (`@athlya/shared/theme.css`) from the
 * design tokens. Idempotent; `tests/theme-css.test.ts` fails when the
 * committed file differs from this output.
 *
 * Run with `pnpm --filter @athlya/shared run build:theme-css`. The
 * relative `.ts` imports are resolved by Node's type stripping; the
 * imported modules only carry type imports, which it erases.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveBrandColorVariables } from '../src/theming/brand-color.ts';
import { buildThemeCss } from '../src/theming/theme-css.ts';
import { tokens } from '../src/tokens.ts';

const target = resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles/theme.css');
const css = buildThemeCss(tokens, deriveBrandColorVariables(tokens.colors.light.primary));
writeFileSync(target, css, 'utf8');
console.log(`[generate-theme-css] wrote ${target} (${css.length.toString()} bytes)`);
