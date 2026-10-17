#!/usr/bin/env node
/**
 * Checklist — Sentry source maps + release tracking (issue #138).
 *
 * Usage: node scripts/verify-sentry-sourcemaps-checklist.mjs
 */

const ITEMS = [
  {
    id: 'M1',
    label: 'wrangler.toml: upload_source_maps = true + deploy --outdir dist',
    doc: 'packages/api/wrangler.toml + deploy-production.yml',
  },
  {
    id: 'M2',
    label: "Release = ${GITHUB_SHA:0:7} = VERSION tagué sur events (event.release)",
    doc: 'packages/api/src/sentry.ts',
  },
  {
    id: 'M2b',
    label: 'Events sérialisent Error.stack en stacktrace.frames (sinon rien à matcher)',
    doc: 'packages/api/src/sentry.ts → parseStackFrames',
  },
  {
    id: 'M3',
    label: 'Étape CI: sentry-cli new/inject/upload/set-commits/finalize/deploys',
    doc: '.github/workflows/deploy-production.yml § Sentry release + source maps',
  },
  {
    id: 'M4',
    label: 'Soft-gate SENTRY_AUTH_TOKEN/ORG/PROJECT en staging uniquement (production échoue)',
    doc: 'deploy-production.yml',
  },
  {
    id: 'M5',
    label: 'Secrets/vars CI provisionnés (SENTRY_AUTH_TOKEN secret, SENTRY_ORG/PROJECT vars)',
    doc: 'docs/runbooks/sentry-sourcemaps.md § Secrets',
  },
  {
    id: 'M6',
    label: 'Test staging: erreur 5xx → event Sentry avec frames file:line + release + deploy marker',
    doc: 'docs/runbooks/sentry-sourcemaps.md § Vérification',
  },
];

console.log('Sentry source maps & release tracking checklist (issue #138)\n');
for (const item of ITEMS) {
  console.log(`[ ] ${item.id} — ${item.label}`);
  console.log(`    → ${item.doc}\n`);
}
