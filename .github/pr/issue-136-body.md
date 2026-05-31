## Contexte

Issue #136 (P2 security, audit O5). La CSP prod émet `report-to`/`report-uri` (déjà câblé dans `apps/web/src/lib/csp.ts` + `proxy.ts`), mais **aucun endpoint ne reçoit** les violations → injections script bloquées invisibles côté ops.

## Changements

- **`packages/api/src/routes/csp-report.ts`** : `POST /v1/csp-report` public, accepte les deux shapes navigateur :
  - `application/csp-report` (legacy report-uri) : `{ "csp-report": {...} }`
  - `application/reports+json` (Reporting API report-to) : `[ { type, body, url } ]`
  - normalise (`blocked-uri`/`blockedURL`, `violated-directive`/`effectiveDirective`…), émet `csp.violation` (`metric: csp_violation_total`), **toujours 204** (fire-and-forget, jamais d'erreur au navigateur), cap 20 reports/req.
- **Wiring `worker.ts`** : mount public, skip du gate `jwtAuth` `/v1/*` (comme `/v1/auth/*`), mais reste derrière le limiter IP fail-closed-soft (anti-flood).
- **Alerte A18** + query Axiom (filtre bruit extensions) + `verify-axiom-alerts-checklist` (17 → 18) + `verify-csp-report-checklist.mjs`.
- **ACTION-ITEMS S4 fermé** + note prod (`NEXT_PUBLIC_CSP_REPORT_URI=https://api.athlya.app/v1/csp-report`).
- Tests : 5 (legacy, reporting API, parse-error, no-op, cap).

## Critères d'acceptation

- [x] report-to actif prod web + studio (déjà câblé ; reste à set l'env var en prod, documenté)
- [x] Test violation déclenchée → log reçu (`csp-report.test.ts`)
- [x] ACTION-ITEMS S4 fermé

## Note

L'endpoint est public par nature (navigateurs sans credentials). Défenses : limiter IP global, cap reports/req, 204 systématique, aucun écho de l'input. Le `NEXT_PUBLIC_CSP_REPORT_URI` est déjà dans la liste des 18 secrets prod.

Closes #136
