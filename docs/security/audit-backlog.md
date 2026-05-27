# Audit backlog — findings résiduels

Tracking issue **#79**. Tous les CRITICAL/HIGH sont fermés code-side (Sprints 1–9). Ce fichier liste les **MEDIUM / LOW / INFO** encore ouverts ou délégués à une issue GitHub dédiée.

## MEDIUM — code ou infra

| ID      | Sujet                                      | Statut   | Issue / slice        |
| ------- | ------------------------------------------ | -------- | -------------------- |
| S6-001  | CSP `style-src` vs React `style={{}}`      | ouvert   | #75                  |
| S2-010  | Logout per-device                          | backlog  | —                    |
| S4-009  | Outbox quota per-user                      | partiel  | rate limit global OK |
| S4-010  | Canary / graduel deploy                    | doc      | #80                  |
| S4-011  | Queue topology par domaine                 | ADR      | #81                  |
| —       | Admin `/admin/*` defense in depth          | doc      | #74                  |
| —       | OTel sampling prod                         | fermé    | #83                  |
| —       | bcrypt 72 bytes                            | fermé    | #78                  |
| —       | Cost alerting                              | doc      | #82                  |
| —       | JWT rotation automation                    | backlog  | #77                  |
| —       | Sentry/OTel SDK officiels                  | backlog  | #76                  |
| —       | Stripe prod checklist                      | fermé    | #69                  |

## MEDIUM / LOW — ops uniquement

| ID     | Action                                      | Owner |
| ------ | ------------------------------------------- | ----- |
| S4-009 | HSTS preload `hstspreload.org`              | ops   |
| S5-009 | Turnstile sur ForgotPassword (secret prod)  | ops   |
| —      | Email DPO dans DPIA                         | DPO   |
| —      | Re-audit T+12 mois                          | sec   |

## INFO (17) — nice-to-have

Voir sections « INFO » dans `audit-S1-static.md` … `audit-S6-frontend.md`. Pas de ticket sauf demande produit. Priorisation : après prod stable 6 mois (README).

## Comment mettre à jour

1. Corriger le code ou merger la PR liée.
2. Passer la ligne en **fermé** ici + une ligne dans `docs/modifications/modifications.md`.
3. Ajuster le tableau `docs/security/README.md` (compteurs MEDIUM/LOW).

## Références

- [`AUDIT-SUMMARY.md`](./AUDIT-SUMMARY.md)
- [`../modifications/modifications.md`](../modifications/modifications.md) Vagues 24–37
- Issues GitHub labels `security`, `priority: medium`
