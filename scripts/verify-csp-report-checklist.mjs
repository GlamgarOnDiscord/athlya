#!/usr/bin/env node
/**
 * Checklist — CSP violation report sink (issue #136).
 *
 * Usage: node scripts/verify-csp-report-checklist.mjs
 */

const ITEMS = [
  {
    id: 'P1',
    label: 'Endpoint public POST /v1/csp-report (skip jwtAuth, derrière limiter IP)',
    doc: 'packages/api/src/routes/csp-report.ts + worker.ts mount',
  },
  {
    id: 'P2',
    label: 'Accepte application/csp-report (legacy) ET application/reports+json (Reporting API)',
    doc: 'normalise() — blocked-uri/blockedURL, violated-directive/effectiveDirective',
  },
  {
    id: 'P3',
    label: 'Log csp.violation (metric csp_violation_total), 204 toujours, cap 20 reports/req',
    doc: 'CSP_VIOLATION_METRIC',
  },
  {
    id: 'P4',
    label: 'Web émet report-to/report-uri + header Report-To si NEXT_PUBLIC_CSP_REPORT_URI set',
    doc: 'apps/web/src/lib/csp.ts + proxy.ts (déjà câblé)',
  },
  {
    id: 'P5',
    label: 'PROD: définir NEXT_PUBLIC_CSP_REPORT_URI=https://api.athlya.app/v1/csp-report (web + studio)',
    doc: 'docs/security/runbook-production-deploy.md',
  },
  {
    id: 'P6',
    label: 'Test violation déclenchée → log reçu (curl POST csp-report)',
    doc: 'packages/api/src/__tests__/csp-report.test.ts',
  },
  {
    id: 'P7',
    label: 'Alerte Axiom A18 provisionnée + query (filtre bruit extensions)',
    doc: 'docs/operations/axiom-alerts.md § A18',
  },
  {
    id: 'P8',
    label: 'ACTION-ITEMS S4 fermé',
    doc: 'docs/ACTION-ITEMS.md § S4',
  },
];

console.log('CSP report sink checklist (issue #136)\n');
for (const item of ITEMS) {
  console.log(`[ ] ${item.id} — ${item.label}`);
  console.log(`    → ${item.doc}\n`);
}
