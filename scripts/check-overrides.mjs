/**
 * check-overrides — warn when pnpm overrides are stale (> 6 months old).
 *
 * Run manually: node scripts/check-overrides.mjs
 * Run in CI:    pnpm check-overrides
 *
 * Exit code 0 always (warnings only, never fails the build).
 * Each override is documented in scripts/overrides-rationale.json.
 * Issue #341.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const rationale = JSON.parse(readFileSync(join(HERE, 'overrides-rationale.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));

const packageOverrides = new Set(Object.keys(pkg.pnpm?.overrides ?? {}));
const documented = new Set(Object.keys(rationale.overrides));

const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;
const now = Date.now();

let warnings = 0;

for (const key of packageOverrides) {
  if (!documented.has(key)) {
    console.warn(`[check-overrides] WARN undocumented override "${key}" — add it to scripts/overrides-rationale.json`);
    warnings++;
  }
}

for (const key of documented) {
  if (!packageOverrides.has(key)) {
    console.warn(`[check-overrides] WARN rationale entry "${key}" has no matching pnpm.override — remove it from scripts/overrides-rationale.json`);
    warnings++;
  }
}

for (const [key, meta] of Object.entries(rationale.overrides)) {
  if (!packageOverrides.has(key)) continue;

  const added = new Date(meta.added).getTime();
  const ageMs = now - added;

  if (ageMs > SIX_MONTHS_MS) {
    const months = Math.floor(ageMs / (30 * 24 * 60 * 60 * 1000));
    console.warn(
      `[check-overrides] WARN override "${key}" is ${String(months)} months old. ` +
        `Remove when: ${meta.remove_when}. ` +
        `CVE/GHSA: ${meta.cve ?? meta.ghsa ?? 'n/a'}.`,
    );
    warnings++;
  }
}

if (warnings === 0) {
  console.log('[check-overrides] OK all overrides documented and under 6 months old.');
} else {
  console.warn(`[check-overrides] ${String(warnings)} warning(s). See above. Exit 0 (warns only).`);
}

process.exit(0);
