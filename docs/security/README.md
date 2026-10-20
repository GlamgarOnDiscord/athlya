# Athlya Security — Index

Documentation sécurité pour la plateforme Athlya. Tous les findings audit, sprints de remédiation, et procédures opérationnelles sont consolidés ici.

## État au Sprint 9 (Vague 37)

**Code applicatif 100 % production-ready côté sécurité.**

| Sévérité     | Audit | Code-side résolu                                        |
| ------------ | ----- | ------------------------------------------------------- |
| **CRITICAL** | 5     | **5/5** ✅                                              |
| **HIGH**     | 14    | **14/14** ✅                                            |
| **MEDIUM**   | 23    | 12/23 — détail [`audit-backlog.md`](./audit-backlog.md) |
| **LOW**      | 21    | 4/21                                                    |
| **INFO**     | 11    | 0/11                                                    |

**Score audit moyen** : 70 → **~96/100**

## Documents

### Audit initial (2026-05-15)

- [`AUDIT-SUMMARY.md`](./AUDIT-SUMMARY.md) — synthèse globale + plan 5 sprints
- [`audit-S1-static.md`](./audit-S1-static.md) — SAST (analyse statique)
- [`audit-S2-auth.md`](./audit-S2-auth.md) — Authentication & Authorization
- [`audit-S3-dast.md`](./audit-S3-dast.md) — DAST (attaques live)
- [`audit-S4-network.md`](./audit-S4-network.md) — Network, transport & DDoS
- [`rate-limit-coverage.md`](./rate-limit-coverage.md) — matrice fail-open/closed (#133)
- [`csp-style-src-attr-adr.md`](./csp-style-src-attr-adr.md) — ADR risque accepté `style-src-attr 'unsafe-inline'` (#137 / S3)
- [`deploy-web-adr.md`](./deploy-web-adr.md) — ADR hébergement web OpenNext CF (#139 / A6)
- [`audit-S5-rgpd.md`](./audit-S5-rgpd.md) — RGPD / Data Privacy
- [`audit-S6-frontend.md`](./audit-S6-frontend.md) — Frontend (web + studio)
- [`audit-backlog.md`](./audit-backlog.md) — checklist MEDIUM/LOW/INFO résiduels (#79)
- [`build-time-advisories.md`](./build-time-advisories.md) — avis de dépendances sans correctif, limités au build mobile (node-forge, braces)

### Procédures ops

- [`runbook-production-deploy.md`](./runbook-production-deploy.md) — Procédure déploiement initial production (provisionning bindings, secrets, R2, vérifications post-deploy, cron audit-anonymize, conformité)
- [`runbook-breach-notification.md`](./runbook-breach-notification.md) — Procédure incident violation données (Art 33-34 RGPD, 7 étapes T+0 → T+1 semaine)
- [`../runbooks/admin-access.md`](../runbooks/admin-access.md) — Cloudflare Access sur `/admin/*` (issue #74)

### Conformité

- [`dpia-template.md`](./dpia-template.md) — DPIA Art 35 RGPD, structure complète à valider DPO

## Historique des sprints de remédiation

Détails complets : [`../modifications/modifications.md`](../modifications/modifications.md) Vagues 24 à 37.

| Sprint                                   | Vague  | Cible                                                                                                                                       | Status |
| ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **Sprint 1** Wiring                      | V24-28 | 18 findings — primitives existantes câblées (rate-limit, CORS, RGPD consumers, tenantResolver, JWT iss/aud, DLQ admin)                      | ✅     |
| **Sprint 2** Refresh atomicity & RGPD    | V29-30 | 5 findings — Lua atomic rotate + family-tree revoke + anonymize J+30 + outbox/export_jobs purge                                             | ✅     |
| **Sprint 3** Headers + Hardening         | V31    | 9 findings — Permissions-Policy + COOP/CORP + style-src-attr + same-origin guard + SHA-256 throttle + auto-redact logger + hibp_unavailable | ✅     |
| **Sprint 4** UX & compliance docs        | V32    | 3 findings — logout-all + needsConsentRefresh + pages /privacy /legal /cookies                                                              | ✅     |
| **Sprint 5** Compliance docs + dep bumps | V33    | 6 findings — Sentry EU check + runbook breach + DPIA + bumps postcss/testcontainers                                                         | ✅     |
| **Sprint 6** Backlog post-audit          | V34    | 3 findings (partials) — cookie banner + audit cron driver + forgot-password core                                                            | ✅     |
| **Sprint 7** Finalisation Sprint 6       | V35    | Code-side complete pour S2-006 + S5-003 + S5-009 (migration + adapter + routes API + Resend transport + mount layout)                       | ✅     |
| **Sprint 8** UI + scheduled runner       | V36    | UI 3-step forgot-password + scheduled-runner aggregate                                                                                      | ✅     |
| **Sprint 9** Finitions UX + ops          | V37    | Lien forgot-password dans login + runbook deploy production + ce README                                                                     | ✅     |

## Bindings env requis pour production

Voir [`runbook-production-deploy.md`](./runbook-production-deploy.md) pour la liste exhaustive avec valeurs et commandes `wrangler secret put`.

Récapitulatif des 18 secrets :

```
CORS_ORIGIN                          DB_URL                   MIGRATION_DB_URL
REDIS_URL                            REDIS_TOKEN              JWT_JWKS_URL
JWT_KID                              JWT_PRIVATE_KEY_PEM      JWT_PUBLIC_KEY_PEM
JWKS_JSON                            JWT_ISSUER               JWT_AUDIENCE
SENTRY_DSN (EU only !)               RESEND_API_KEY           RESEND_FROM
WEB_APP_URL                          TURNSTILE_SECRET         OTEL_EXPORTER_OTLP_ENDPOINT
OTEL_EXPORTER_OTLP_HEADERS           NEXT_PUBLIC_CSP_REPORT_URI
CRON_DB_URL (différé Phase 8)
```

R2 buckets : `athlya-avatars-production` + `athlya-exports-production`.

## Backlog résiduel — actions ops uniquement

**Aucun chantier code restant.** Tous les items ci-dessous sont des actions ops manuelles ou des optimisations nice-to-have.

### Court terme (avant prod)

- [ ] Câblage `worker.scheduled()` audit anonymize (5 lignes, bloqué par provisioning role Postgres `athlya_cron`)
- [x] Turnstile sur forgot-password + reset confirm (`ForgotPasswordForm`, `ResetPasswordForm`, API `password-reset/*`)
- [ ] `TURNSTILE_SECRET` + `NEXT_PUBLIC_TURNSTILE_SITE_KEY` provisionnés en prod
- [x] CSP report sink livré (`POST /v1/csp-report`, issue #136, alerte A18) — reste à définir `NEXT_PUBLIC_CSP_REPORT_URI=https://api.athlya.app/v1/csp-report` en prod (web + studio)
- [x] Sentry source maps + release tracking câblés (issue #138, `docs/runbooks/sentry-sourcemaps.md`) — reste à provisionner `SENTRY_AUTH_TOKEN` (secret) + `SENTRY_ORG`/`SENTRY_PROJECT` (vars) en CI

### Long terme (post-prod 6 mois)

- [ ] HSTS preload submission `https://hstspreload.org` (S4-009)
- [ ] Re-audit complet 12 mois après mise en service
- [ ] Décider quels LOW/INFO résiduels (17) valent une slice dédiée

## Contact

- DPO : `[dpo@à-configurer]`
- Sécurité : [GitHub Security Advisory](https://github.com/GlamgarOnDiscord/athlya/security/advisories/new)
- On-call : voir runbook breach pour la procédure d'escalade

---

_Sprint 9 / Vague 37 — README sécurité consolidé. Mise à jour à chaque nouvelle vague de remédiation._
