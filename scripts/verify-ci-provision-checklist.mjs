#!/usr/bin/env node
/**
 * CI recovery checklist (issue #123).
 */

const STEPS = [
  'GitHub Actions billing / quota restored',
  'gh workflow run ci.yml --ref master succeeded',
  'gh workflow run pgtap.yml --ref master succeeded',
  'gh workflow run integration-docker.yml --ref master succeeded',
  '3 consecutive green master runs (node scripts/verify-ci-health.mjs --strict)',
  'Branch protection matches docs/runbooks/branch-protection.md (required check: Lint, typecheck, and tests; 1 code-owner approval)',
  'Repository vars K6_STAGING_BASE_URL / ZAP_TARGET_URL set or weekly ci-required-vars acknowledged',
];

console.log('CI recovery checklist (issue #123)\n');
console.log('Runbook: docs/runbooks/ci-recovery.md\n');
for (const s of STEPS) {
  console.log(`[ ] ${s}`);
}
