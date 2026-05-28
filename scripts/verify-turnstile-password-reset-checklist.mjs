#!/usr/bin/env node
/**
 * Turnstile password-reset checklist (issue #131).
 */

const STEPS = [
  {
    id: 'T1',
    label: 'TURNSTILE_SECRET provisionné (staging + production)',
    doc: 'docs/security/runbook-production-deploy.md',
  },
  {
    id: 'T2',
    label: 'NEXT_PUBLIC_TURNSTILE_SITE_KEY sur app web prod',
    doc: 'docs/security/runbook-production-deploy.md',
  },
  {
    id: 'T3',
    label: 'API 403 sans cf-turnstile-token sur password-reset/request',
    doc: 'pnpm --filter @athlya/api test -- src/__tests__/routes/auth.test.ts',
  },
  {
    id: 'T4',
    label: 'ForgotPasswordForm + ResetPasswordForm : widget + gate client',
    doc: 'apps/web/src/app/forgot-password/ForgotPasswordForm.tsx',
  },
  {
    id: 'T5',
    label: 'curl prod password-reset sans token → 403',
    doc: 'docs/security/runbook-production-deploy.md § Turnstile check',
  },
  {
    id: 'T6',
    label: 'docs/security/README.md bloc Turnstile relu',
    doc: 'docs/security/README.md',
  },
];

const json = process.argv.includes('--json');
if (json) {
  console.log(JSON.stringify({ issue: 131, steps: STEPS }, null, 2));
  process.exit(0);
}

console.log('Turnstile password-reset checklist (issue #131)\n');
for (const s of STEPS) {
  console.log(`[ ] ${s.id} — ${s.label}`);
  console.log(`    → ${s.doc}\n`);
}
