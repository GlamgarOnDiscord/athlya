#!/usr/bin/env node
/**
 * Guard against high-risk documentation drift by checking invariants
 * that are easy to verify against source-of-truth files:
 *
 *   1. The Node version in .nvmrc is covered by package.json#engines.node.
 *   2. apps/web's lint script does not invoke `next lint` (removed in Next 16).
 *   3. No active (non-archived) markdown references .eslintrc.json as a
 *      pending action item (migration was completed; re-applying it would
 *      regress the flat-config setup).
 *   4. No active doc claims Cloudflare Smart Placement is "EU only" (it is
 *      a latency optimisation, not a legal/regional pin — see
 *      docs/security/eu-data-residency-adr.md).
 *
 * A file is considered "archived" when its first 300 characters contain an
 * archive banner matching /archive\s+snapshot/i — the convention adopted
 * across docs/frameworks/*.md.
 *
 * Exit 1 on any violation. Run as: node scripts/check-docs-drift.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function isArchived(content) {
  return /archive\s+snapshot/i.test(content.slice(0, 300));
}

/** Recursively collect all .md files under a directory. */
function collectMd(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMd(full));
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      results.push(full);
    }
  }
  return results;
}

const failures = [];

function fail(msg) {
  failures.push(msg);
  console.error(`FAIL: ${msg}`);
}

// ---------------------------------------------------------------------------
// 1. .nvmrc node version is covered by package.json#engines.node
// ---------------------------------------------------------------------------

const nvmrcRaw = read('.nvmrc').trim();
const pkg = JSON.parse(read('package.json'));
const enginesNode = pkg.engines?.node ?? '';

// .nvmrc contains e.g. "20.18.1"; engines.node contains e.g. ">=20.18.1 <21"
// Build a simple semver range check: extract major version from nvmrc and
// verify it satisfies the engines constraint via node's built-in semver-ish
// comparison (good enough for the major/minor pin we use here).
const nvmrcVersion = nvmrcRaw.replace(/^v/, '');
const [major] = nvmrcVersion.split('.').map(Number);

// Parse engines.node: expect ">=A.B.C <D" or similar.
const geMatch = enginesNode.match(/>=\s*(\d+)\./);
const ltMatch = enginesNode.match(/<\s*(\d+)/);
const engineMin = geMatch ? Number(geMatch[1]) : null;
const engineMax = ltMatch ? Number(ltMatch[1]) : null;

if (engineMin === null || engineMax === null) {
  fail(
    `.nvmrc version ${nvmrcVersion} cannot be validated: package.json#engines.node "${enginesNode}" does not follow the expected ">= A <B" pattern`,
  );
} else if (major < engineMin || major >= engineMax) {
  fail(
    `.nvmrc declares Node ${nvmrcVersion} (major ${major}) but package.json#engines.node is "${enginesNode}" — the two sources of truth disagree`,
  );
} else {
  console.log(`OK: .nvmrc Node ${nvmrcVersion} is within engines.node "${enginesNode}"`);
}

// ---------------------------------------------------------------------------
// 2. apps/web lint script must not be "next lint"
// ---------------------------------------------------------------------------

const webPkg = JSON.parse(read('apps/web/package.json'));
const lintScript = webPkg.scripts?.lint ?? '';
if (/next\s+lint/.test(lintScript)) {
  fail(
    `apps/web/package.json#scripts.lint is "${lintScript}" — "next lint" was removed in Next 16; use "eslint ." instead`,
  );
} else {
  console.log(`OK: apps/web lint script is "${lintScript}" (no "next lint")`);
}

// ---------------------------------------------------------------------------
// 3. No active doc refers to .eslintrc.json as a pending action item
// ---------------------------------------------------------------------------

const ESLINTRC_RE =
  /\.eslintrc(?:\.json|\.js|\.cjs)?\b.*(?:TODO|action|migrate|supprimer|delete|pending|\[ \])/i;

const mdFiles = collectMd(join(ROOT, 'docs'))
  .concat(collectMd(join(ROOT, 'apps', 'web')).filter((f) => f.endsWith('README.md')))
  .concat([join(ROOT, 'CONTRIBUTING.md'), join(ROOT, 'README.md')].filter((f) => {
    try { statSync(f); return true; } catch { return false; }
  }));

let eslintrcOk = true;
for (const file of mdFiles) {
  const content = readFileSync(file, 'utf8');
  if (isArchived(content)) continue;
  for (const line of content.split('\n')) {
    if (ESLINTRC_RE.test(line)) {
      const rel = file.replace(ROOT + '\\', '').replace(ROOT + '/', '');
      fail(`Active doc references .eslintrc.json as a pending action: ${rel}: ${line.trim()}`);
      eslintrcOk = false;
    }
  }
}
if (eslintrcOk) {
  console.log('OK: no active doc references .eslintrc.json as a pending action');
}

// ---------------------------------------------------------------------------
// 4. No active doc claims Smart Placement is "EU only"
// ---------------------------------------------------------------------------

// Flag lines where "Smart Placement" and an EU-only claim appear on the same
// line WITHOUT a negation word. Negation words: not, pas, non, kein, no,
// n'est, cannot, isn't, aucune.
const NEGATION_RE = /\b(?:not|pas|non|kein|no|n'est|cannot|isn't|aucune)\b/i;
const SP_EU_ONLY_RE = /smart\s+placement[^.!?\n]*\beu[\s-]*only\b|\beu[\s-]*only\b[^.!?\n]*smart\s+placement/i;

let euOnlyOk = true;
for (const file of mdFiles) {
  const content = readFileSync(file, 'utf8');
  if (isArchived(content)) continue;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SP_EU_ONLY_RE.test(line) && !NEGATION_RE.test(line)) {
      const rel = file.replace(ROOT + '\\', '').replace(ROOT + '/', '');
      fail(
        `Active doc claims Smart Placement is "EU only" — it is a latency optimisation, not a legal/regional pin. See docs/security/eu-data-residency-adr.md. File: ${rel}:${i + 1}: ${line.trim()}`,
      );
      euOnlyOk = false;
    }
  }
}
if (euOnlyOk) {
  console.log('OK: no active doc misrepresents Smart Placement as "EU only"');
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n${failures.length} documentation drift violation(s) found.`);
  process.exit(1);
} else {
  console.log('\nAll documentation drift checks passed.');
}
