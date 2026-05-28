#!/usr/bin/env node
/**
 * Check recent GitHub Actions health on master (issue #123).
 *
 * Usage:
 *   node scripts/verify-ci-health.mjs
 *   node scripts/verify-ci-health.mjs --strict   (exit 1 if any required workflow failed)
 *
 * Requires: gh CLI authenticated.
 */

import { execSync } from 'node:child_process';

const STRICT = process.argv.includes('--strict');
const REQUIRED = [
  { workflow: 'ci.yml', label: 'CI' },
  { workflow: 'pgtap.yml', label: 'pgTAP' },
  { workflow: 'integration-docker.yml', label: 'Integration Docker' },
];

function ghJson(cmd) {
  const out = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

let allOk = true;

console.log('CI health (latest master runs)\n');

for (const { workflow, label } of REQUIRED) {
  let runs;
  try {
    runs = ghJson(
      `gh run list --workflow ${workflow} --branch master --limit 3 --json databaseId,conclusion,status,createdAt`,
    );
  } catch (err) {
    console.log(`[?] ${label} (${workflow}): gh error — ${err instanceof Error ? err.message : err}`);
    allOk = false;
    continue;
  }

  const latest = runs[0];
  if (latest === undefined) {
    console.log(`[FAIL] ${label}: no runs found`);
    allOk = false;
    continue;
  }

  const ok = latest.conclusion === 'success';
  const icon = ok ? 'OK' : 'FAIL';
  console.log(
    `[${icon}] ${label}: ${latest.conclusion ?? latest.status} (run ${latest.databaseId}, ${latest.createdAt})`,
  );
  if (!ok) allOk = false;
}

console.log('\nRunbook: docs/runbooks/ci-recovery.md');

if (STRICT && !allOk) {
  process.exit(1);
}
