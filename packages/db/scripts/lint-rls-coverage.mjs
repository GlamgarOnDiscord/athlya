#!/usr/bin/env node
/**
 * lint-rls-coverage.mjs
 *
 * Scans ALL forward migrations for every `CREATE POLICY "<name>"` declaration
 * and verifies that each policy name appears at least once in a test file
 * under `tests/rls/`. Previously only `0001_rls.sql` was scanned; later
 * migrations added 19+ policies that were invisible to this check (issue #499).
 *
 * Exits 0 on full coverage, 1 when at least one policy is uncovered.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

const migrationsDir = join(pkgRoot, 'migrations');
const testsDir = join(pkgRoot, 'tests', 'rls');

const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => join(migrationsDir, f));

const policyNameRegex = /CREATE POLICY\s+"([^"]+)"\s+ON/g;
const policyNames = new Set();

for (const file of migrationFiles) {
  const sql = readFileSync(file, 'utf8');
  let match;
  while ((match = policyNameRegex.exec(sql)) !== null) {
    policyNames.add(match[1]);
  }
  policyNameRegex.lastIndex = 0;
}

if (policyNames.size === 0) {
  console.error('lint-rls-coverage: no CREATE POLICY statements found across all migrations — regex may be stale.');
  process.exit(2);
}

const testFiles = readdirSync(testsDir)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => join(testsDir, f));

const testBlob = testFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

const missing = [];
for (const name of policyNames) {
  if (!testBlob.includes(name)) {
    missing.push(name);
  }
}

if (missing.length > 0) {
  console.error(
    `lint-rls-coverage: ${missing.length} polic${missing.length === 1 ? 'y' : 'ies'} not referenced by any test file under tests/rls/:`,
  );
  for (const name of missing.sort()) {
    console.error(`  - ${name}`);
  }
  process.exit(1);
}

console.log(
  `lint-rls-coverage: OK — all ${policyNames.size} policies across ${migrationFiles.length} migrations are covered.`,
);
