# Audit backlog — findings résiduels

Tracking issue **#79**. Tous les CRITICAL/HIGH sont fermés code-side (Sprints 1–9). Ce fichier liste les **MEDIUM / LOW / INFO** encore ouverts ou délégués à une issue GitHub dédiée.

## MEDIUM — code ou infra

Statuses checked against `master` on 2026-10-19. `Sx-0yy` IDs refer to the `audit-Sx-*.md` files; a row without an ID comes from a follow-up issue, not from an audit finding.

| ID     | Subject                               | Status                   | Issue / slice                                                                                                                     |
| ------ | ------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| S6-001 | CSP `style-src` vs React `style={{}}` | resolved (risk accepted) | #137 — ADR `csp-style-src-attr-adr.md` (Option C, risque LOW documenté)                                                           |
| S2-010 | Logout per-device                     | resolved                 | #674                                                                                                                              |
| S2-011 | OAuth verifier accepts RS256 + ES256  | in progress              | #689 (RS256 only, audience required; OAuth routes unmounted since B8.4)                                                           |
| S2-012 | Refresh token in the JSON body        | partial                  | Body kept (mobile app, OS keychain); web/studio proxies move it to the HttpOnly cookie; logger redaction of `*Token` keys in #689 |
| S4-004 | Outbox flooding per user              | partial                  | Per-user mutation budgets after `jwtAuth` (#613, #623); no dedicated outbox quota                                                 |
| S4-010 | No SRI on the Turnstile script        | open (LOW risk)          | `v0/api.js` is mutable, so SRI cannot apply as is; the versioned-proxy alternative is in S6-007                                   |
| S4-011 | Idempotency cache flooding            | in progress              | #689 (expired-key purge, migration 0047); write rate bounded by the mutation budgets (#623)                                       |
| —      | Canary / gradual deploy               | closed                   | #80 (runbook), #129 (automation), #579/#607 (smoke + error-budget gates), #632 (SLO rollback)                                     |
| —      | Queue topology per domain             | closed                   | #81, #125 — `athlya-events-notifications` / `athlya-events-rgpd`, `src/events/route-queue.ts`, `event-bus.md` §6                  |
| —      | Admin `/admin/*` defense in depth     | closed                   | #74 (runbook `admin-access.md`), #121 (Cloudflare Access enforced)                                                                |
| —      | OTel sampling prod                    | closed                   | #83                                                                                                                               |
| —      | bcrypt 72 bytes                       | closed                   | #78                                                                                                                               |
| —      | Cost alerting                         | doc                      | #82 — runbook `cost-monitoring.md`                                                                                                |
| —      | JWT rotation automation               | closed                   | #77 — `scripts/rotate-jwt-prepare.mjs`, audit row on rotate (#127, `admin/jwt-rotate-routes.ts`), runbook `rotate-jwt.md`         |
| —      | Sentry/OTel SDK officiels             | rejected (ADR)           | #76 — `docs/operations/observability-hand-rolled-adr.md` (Worker bundle size)                                                     |
| —      | Stripe prod checklist                 | closed                   | #69                                                                                                                               |

## MEDIUM / LOW — ops uniquement

| ID     | Action                                     | Owner |
| ------ | ------------------------------------------ | ----- |
| S4-009 | HSTS preload `hstspreload.org`             | ops   |
| S5-009 | Turnstile sur ForgotPassword (secret prod) | ops   |
| —      | Email DPO dans DPIA                        | DPO   |
| —      | Re-audit T+12 mois                         | sec   |

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
