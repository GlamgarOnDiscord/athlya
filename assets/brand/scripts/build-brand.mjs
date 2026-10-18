// A-mi, the Athlya mascot: a forward-leaning italic "A" that runs.
// Generates every committed SVG under assets/brand/svg.
//
// Usage (from a scratch directory, the deps are not part of the workspace):
//   npm i opentype.js@1.3.4 @fontsource/archivo-black@5.1.0
//   node /path/to/athlya/assets/brand/scripts/build-brand.mjs /path/to/athlya/assets/brand/svg
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const COLORS = { ink: '#0A0A0A', volt: '#D7FF3A', white: '#FFFFFF' };

const SKEW = -12;
const tan = Math.tan((SKEW * Math.PI) / 180);
// x-shift of the skewed body at height y (body group is translated by 10).
const sx = (x, y) => x + 10 + tan * y;

const F = (d, c) => `<path d="${d}" fill="${c}"/>`;
const S = (d, w, c) =>
  `<path d="${d}" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
const E = (cx, cy, rx, ry, c) =>
  `<ellipse cx="${cx.toFixed(2)}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${c}"/>`;

/**
 * Mascot on a 100x100 grid.
 * @param body body + arms + speed lines colour
 * @param eyes eye colour (usually the background)
 * @param band headband colour
 */
export function mascot(body, eyes, band) {
  const bodyPath = `<g transform="translate(10 0) skewX(${SKEW})">${F('M32 90 L52 14 L72 14 L92 90 L74 90 L62 46 L50 90 Z', body)}</g>`;
  // Headband across the forehead with two tails flying back.
  const by = 21;
  const bandPath =
    `<g transform="translate(10 0) skewX(${SKEW})"><rect x="47" y="${by - 3}" width="29" height="6" rx="3" fill="${band}"/></g>` +
    S(`M${sx(48, by).toFixed(1)} ${by} L${(sx(48, by) - 11).toFixed(1)} ${by + 4}`, 4.5, band) +
    S(`M${sx(48, by).toFixed(1)} ${by + 1} L${(sx(48, by) - 8).toFixed(1)} ${by + 10}`, 4.5, band);
  const ey = 31;
  const eyesPath = E(sx(57, ey), ey, 2.9, 4.2, eyes) + E(sx(66.5, ey), ey, 2.9, 4.2, eyes);
  const arms = S('M45 58 L31 52', 8, body) + S('M84 54 L95 44', 8, body);
  const speed = S('M3 50 H17', 6, body) + S('M7 64 H19', 6, body) + S('M3 78 H13', 6, body);
  return speed + arms + bodyPath + bandPath + eyesPath;
}

// Dependencies and the Archivo Black font (SIL OFL 1.1) resolve from the
// working directory's node_modules.
const require = createRequire(path.join(process.cwd(), 'noop.js'));
const opentype = require('opentype.js');
const archivo = opentype.loadSync(
  require.resolve('@fontsource/archivo-black/files/archivo-black-latin-400-normal.woff'),
);

/** "ATHLYA" in Archivo Black, italicised to match the mascot, as outlines. */
export function wordmark() {
  const size = 100;
  const gl = archivo.stringToGlyphs('ATHLYA');
  const sc = size / archivo.unitsPerEm;
  let x = 0;
  const p = new opentype.Path();
  gl.forEach((g, i) => {
    p.extend(g.getPath(x, 0, size));
    x += g.advanceWidth * sc - 0.01 * size;
    if (i < gl.length - 1) x += archivo.getKerningValue(g, gl[i + 1]) * sc;
  });
  const bb = p.getBoundingBox();
  // Apply the same skew to the outlines so the asset needs no transform.
  const cmds = p.commands.map((c) => {
    const o = { ...c };
    for (const [kx, ky] of [
      ['x', 'y'],
      ['x1', 'y1'],
      ['x2', 'y2'],
    ]) {
      if (o[kx] !== undefined) {
        const y = o[ky] - bb.y1;
        o[kx] = o[kx] - bb.x1 + tan * (y - (bb.y2 - bb.y1));
        o[ky] = y;
      }
    }
    return o;
  });
  let minX = Infinity;
  let maxX = -Infinity;
  for (const c of cmds)
    for (const k of ['x', 'x1', 'x2'])
      if (c[k] !== undefined) {
        minX = Math.min(minX, c[k]);
        maxX = Math.max(maxX, c[k]);
      }
  const q = new opentype.Path();
  q.commands = cmds.map((c) => {
    const o = { ...c };
    for (const k of ['x', 'x1', 'x2']) if (o[k] !== undefined) o[k] -= minX;
    return o;
  });
  return { d: q.toPathData(2), w: maxX - minX, h: bb.y2 - bb.y1 };
}

const svg = (w, h, body, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}"${extra}>${body}</svg>\n`;

export function buildAll(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const { ink, volt, white } = COLORS;
  const wm = wordmark();
  const files = {};

  // Mascot alone (transparent background).
  files['athlya-mascot-volt.svg'] = svg(100, 100, mascot(volt, ink, white));
  files['athlya-mascot-ink.svg'] = svg(100, 100, mascot(ink, white, ink));
  files['athlya-mascot-white.svg'] = svg(100, 100, mascot(white, ink, volt));
  files['athlya-mascot-mono.svg'] = svg(
    100,
    100,
    mascot('currentColor', 'var(--athlya-eye, #fff)', 'currentColor'),
  );

  // Wordmark alone.
  for (const [n, c] of Object.entries({ volt, ink, white })) {
    files[`athlya-wordmark-${n}.svg`] = svg(wm.w, wm.h, `<path d="${wm.d}" fill="${c}"/>`);
  }

  // Horizontal lockup: mascot slightly taller than the caps.
  const lockup = (fg, eyes, band) => {
    const ms = (wm.h * 1.22) / 76; // body spans y 14..90
    const mw = 100 * ms;
    const gap = wm.h * 0.12;
    const top = 14 * ms; // body spans y 14..90 on the mascot grid
    const wy = 90 * ms - wm.h;
    return svg(
      mw + gap + wm.w,
      76 * ms + 2,
      `<g transform="translate(0 ${(-top + 1).toFixed(2)}) scale(${ms.toFixed(4)})">${mascot(fg, eyes, band)}</g><path transform="translate(${(mw + gap).toFixed(2)} ${(wy - top + 1).toFixed(2)})" d="${wm.d}" fill="${fg}"/>`,
    );
  };
  files['athlya-lockup-volt.svg'] = lockup(volt, ink, white);
  files['athlya-lockup-ink.svg'] = lockup(ink, white, ink);
  files['athlya-lockup-white.svg'] = lockup(white, ink, volt);

  // App icon (full bleed, maskable-safe: mascot inside the 80% safe circle).
  const icon = (bg, fg, eyes, band, rx = 0) =>
    svg(
      1024,
      1024,
      `<rect width="1024" height="1024" rx="${rx}" fill="${bg}"/><g transform="translate(212 180) scale(6)">${mascot(fg, eyes, band)}</g>`,
    );
  files['athlya-appicon.svg'] = icon(ink, volt, ink, white);
  files['athlya-appicon-light.svg'] = icon(volt, ink, volt, ink);
  files['athlya-favicon.svg'] = icon(ink, volt, ink, white, 232);

  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(outDir, n), c);
  return Object.keys(files);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(buildAll(process.argv[2] ?? 'svg').join('\n'));
}
