#!/usr/bin/env node
/**
 * lint-rls-coverage.mjs — Guardrail for task 2.6.
 *
 * Parses `migrations/0001_rls.sql` for every `CREATE POLICY "<name>"`
 * and verifies that each name appears at least once in a test file
 * under `tests/rls/`. The test files address policies by name in their
 * assertion descriptions (e.g. `'users_read_own: member A ...'`), so a
 * simple string search is sufficient and keeps this script free of
 * dependencies.
 *
 * Exits 0 on full coverage, 1 when at least one policy is missing.
 * Invoked both from `scripts/test-rls.sh` and from the npm script
 * `lint:rls-coverage`. The intent is that an engineer who adds a new
 * policy to `0001_rls.sql` but forgets to write a matching test gets a
 * red build from CI rather than discovering the gap in production.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

const rlsSqlPath = join(pkgRoot, 'migrations', '0001_rls.sql');
const testsDir = join(pkgRoot, 'tests', 'rls');

const rlsSql = readFileSync(rlsSqlPath, 'utf8');

/**
 * Match every `CREATE POLICY "<name>"` declaration. The quotes are
 * required by the migration for consistency with drizzle-kit's output.
 * We do not match `DROP POLICY IF EXISTS` on purpose — a policy that
 * is only dropped and never re-created is a bug in the migration, not
 * a test-coverage issue.
 */
const policyNameRegex = /CREATE POLICY\s+"([^"]+)"\s+ON/g;
const policyNames = new Set();
let match;
while ((match = policyNameRegex.exec(rlsSql)) !== null) {
    policyNames.add(match[1]);
}

if (policyNames.size === 0) {
    console.error(
        `lint-rls-coverage: no policies found in ${rlsSqlPath} — the regex is likely stale.`,
    );
    process.exit(2);
}

const testFiles = readdirSync(testsDir)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => join(testsDir, file));

const testBlob = testFiles.map((file) => readFileSync(file, 'utf8')).join('\n');

const missing = [];
for (const name of policyNames) {
    if (!testBlob.includes(name)) {
        missing.push(name);
    }
}

if (missing.length > 0) {
    console.error(
        `lint-rls-coverage: ${missing.length} policy/policies are not referenced by any pgTAP test file:`,
    );
    for (const name of missing.sort()) {
        console.error(`  - ${name}`);
    }
    console.error(
        `\nExpected every CREATE POLICY name from 0001_rls.sql to appear in at least one file under ${testsDir}.`,
    );
    process.exit(1);
}

console.log(
    `lint-rls-coverage: OK — all ${policyNames.size} policies from 0001_rls.sql are covered by tests under tests/rls/.`,
);
