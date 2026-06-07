## Résumé

CSP production sans `report-to` / `report-uri` actif. Violations XSS (ex. injection script bloquée) **invisibles** côté ops.

**Finding audit** : O5 — gravité **Medium**, priorité **P2**.

ACTION-ITEMS S4 ouvert.

## Solution proposée

1. Endpoint `POST /v1/csp-report` (ou CF Reporting API)
2. Directive CSP : `report-to csp-endpoint`
3. Logs structurés + alerte spike violations
4. Dashboard Axiom violations/semaine

## Critères d'acceptation

- [ ] report-to actif prod web + studio
- [ ] Test violation déclenchée → log reçu
- [ ] ACTION-ITEMS S4 fermé

## Références

- `apps/web/src/lib/csp.ts`
- `docs/ACTION-ITEMS.md` S4
- Audit prod 2026-05-27 — O5

## Priorité

**P2**
