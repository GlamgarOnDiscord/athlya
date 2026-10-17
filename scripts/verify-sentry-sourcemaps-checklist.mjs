#!/usr/bin/env node
/**
 * Checklist — Sentry source maps + release tracking (issues #138, #415).
 *
 * Usage: node scripts/verify-sentry-sourcemaps-checklist.mjs
 */

const ITEMS = [
  {
    id: 'M1',
    label: 'wrangler*.toml: upload_source_maps = true + every deploy path bundles with --outdir',
    doc: 'packages/api/wrangler*.toml + deploy-production.yml + canary.yml',
  },
  {
    id: 'M2',
    label: 'Release = ${GITHUB_SHA:0:7} = VERSION tagged on events (event.release)',
    doc: 'packages/api/src/sentry.ts',
  },
  {
    id: 'M2b',
    label: 'Events serialize Error.stack into stacktrace.frames (otherwise nothing to match)',
    doc: 'packages/api/src/sentry.ts → parseStackFrames',
  },
  {
    id: 'M3',
    label: 'scripts/sentry-release.sh: new/inject/upload/set-commits (prepare) + finalize/deploys',
    doc: 'scripts/sentry-release.sh',
  },
  {
    id: 'M3b',
    label: 'Canary paths upload maps before the first traffic shift and finalize after 100 %',
    doc: 'canary.yml + deploy-production.yml § production-canary',
  },
  {
    id: 'M4',
    label: 'SENTRY_AUTH_TOKEN/ORG/PROJECT soft gate in staging only (production fails)',
    doc: 'scripts/sentry-release.sh',
  },
  {
    id: 'M5',
    label: 'CI secrets/vars provisioned (SENTRY_AUTH_TOKEN secret, SENTRY_ORG/PROJECT vars)',
    doc: 'docs/runbooks/sentry-sourcemaps.md § Required CI secrets / vars',
  },
  {
    id: 'M6',
    label: 'Staging test: 5xx error → Sentry event with file:line frames + release + deploy marker',
    doc: 'docs/runbooks/sentry-sourcemaps.md § Verification',
  },
];

console.log('Sentry source maps & release tracking checklist (issues #138, #415)\n');
for (const item of ITEMS) {
  console.log(`[ ] ${item.id} — ${item.label}`);
  console.log(`    → ${item.doc}\n`);
}
