#!/usr/bin/env node
/**
 * check-legal-placeholders.mjs
 *
 * Fails if any bracket placeholder ([text...]) is found in the legal notice
 * or privacy policy source files. Run before any production deployment.
 *
 * A bracket placeholder has the form [word...] where the first character is
 * a letter (Latin or accented). This pattern covers French placeholders like
 * [forme juridique] or [numéro] while excluding TypeScript/JSX syntax such
 * as [Symbol.asyncIterator] or spread [...items].
 *
 * Issue #516.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webSrc = join(__dirname, '..', 'apps', 'web', 'src', 'app');

const LEGAL_FILES = [join(webSrc, 'legal', 'page.tsx'), join(webSrc, 'privacy', 'page.tsx')];

// Matches [word…] where the first char is a letter (including accented).
// Does not match [Symbol.foo], ['string'], [...spread], or numeric indexes.
const PLACEHOLDER_RE = /\[[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ\s]*\]/g;

let hasPlaceholder = false;

for (const file of LEGAL_FILES) {
  const content = readFileSync(file, 'utf8');
  const matches = [...content.matchAll(PLACEHOLDER_RE)];
  if (matches.length > 0) {
    const relativePath = file.replace(join(__dirname, '..') + '\\', '').replace(/\\/g, '/');
    console.error(`check-legal: placeholder(s) found in ${relativePath}:`);
    for (const m of matches) {
      console.error(`  ${m[0]}`);
    }
    hasPlaceholder = true;
  }
}

if (hasPlaceholder) {
  console.error(
    'check-legal: FAIL — replace all bracket placeholders with real legal metadata before production deploy.',
  );
  console.error('check-legal: See docs/runbooks/legal-content-checklist.md for required fields.');
  process.exit(1);
}

console.log('check-legal: OK — no bracket placeholders found in legal pages.');
