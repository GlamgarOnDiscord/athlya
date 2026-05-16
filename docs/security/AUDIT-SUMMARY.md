# Audit sécurité — Synthèse globale

Date : 2026-05-15
5 audits indépendants livrés en parallèle. Voir détails dans :

- [`audit-S1-static.md`](./audit-S1-static.md) — SAST (analyse statique du code)
- [`audit-S2-auth.md`](./audit-S2-auth.md) — Authentication & Authorization
- [`audit-S3-dast.md`](./audit-S3-dast.md) — DAST (attaques live contre l'API)
- [`audit-S4-network.md`](./audit-S4-network.md) — Network, transport & DDoS
- [`audit-S5-rgpd.md`](./audit-S5-rgpd.md) — RGPD / Data Privacy
- [`audit-S6-frontend.md`](./audit-S6-frontend.md) — Frontend (web + studio)

## Scores par axe

| Axe                  | Score         | Verdict                                  |
| -------------------- | ------------- | ---------------------------------------- |
| S1 — SAST            | **87 / 100**  | excellent (zéro CRITICAL)                |
| S2 — Auth/RBAC       | **58 / 100**  | crypto solide, **wiring défaillant**     |
| S3 — DAST live       | **66 / 100**  | RBAC robuste, rate-limit absent          |
| S4 — Network/DDoS    | **68 / 100**  | TLS+CSP+cookies OK, DDoS appli faible    |
| S5 — RGPD            | **62 / 100**  | machinerie OK, **consumers non câblés**  |
| S6 — Frontend        | **82 / 100**  | très bon, durcissements headers manquent |
| **Moyenne pondérée** | **~70 / 100** | —                                        |

Total findings : **74** (5 CRITICAL, 14 HIGH, 23 MEDIUM, 21 LOW, 11 INFO).

## Pattern récurrent : code testé, jamais branché

Le constat le plus frappant cross-audits :

> Plusieurs primitives de sécurité **existent et sont testées** dans `packages/auth/` et `packages/api/middleware/`, mais ne sont **jamais montées dans `packages/api/src/worker.ts`**.

C'est-à-dire que la suite de tests passe verte sur 436/436 tests, et que pourtant la posture runtime est dégradée. Liste exhaustive des "primitives orphelines" :

| Primitive                                 | Fichier source                                        | Statut prod                       |
| ----------------------------------------- | ----------------------------------------------------- | --------------------------------- |
| `rateLimit()` middleware (Req 14.3, 14.4) | `packages/api/src/middleware/rate-limit.ts`           | jamais `app.use(rateLimit())`     |
| `shouldAllowLogin()` throttle (Req 1.6)   | `packages/auth/src/throttle.ts`                       | jamais appelé dans `auth-deps.ts` |
| `tenantResolver()` middleware             | `packages/api/src/middleware/tenant-resolver.ts`      | jamais monté                      |
| `handleUserDeleted` cascade RGPD (Art 17) | `packages/members/src/cascade.ts`                     | jamais routé sur queue            |
| `runExportJob` consumer (Art 15)          | `packages/members/src/export.ts`                      | jamais routé sur queue            |
| `anonymize_user_audit()` cron J+30        | `packages/db/migrations/0003_audit_anonymization.sql` | jamais déclenché                  |
| `redactKeys()` log sanitizer              | `packages/api/src/logging.ts`                         | exporté mais 0 call-site          |
| DLQ admin router `/admin/dlq/*`           | `packages/api/src/admin/dlq-routes.ts`                | jamais monté dans `buildApp`      |

→ **8 primitives, 8 PROD-RISK ou PROD-BLOCKER**. Le coût total de remédiation est faible (~2-3 jours d'engineering) car aucune logique n'est à écrire — uniquement à câbler.

## Top findings consolidés (priorité absolue)

### CRITICAL — bloquants production

| #   | Audit                    | Finding                                                                   | Mitigation                                                                 |
| --- | ------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | S2-001 / S3-001 / S4-001 | Aucun rate-limit ni login throttle en prod                                | `app.use('/v1/*', rateLimit())` + `shouldAllowLogin()` dans `auth-deps.ts` |
| 2   | S2-002                   | `SessionStore.rotate()` non-atomique → fork de session sur refresh-reuse  | Script Lua Upstash avec `GETDEL`                                           |
| 3   | S5-001                   | `runExportJob` jamais exécuté → exports RGPD perpétuellement pending      | Router `members.export.requested` dans `worker.queue()`                    |
| 4   | S5-002                   | `handleUserDeleted` jamais exécuté → `DELETE /v1/auth/me` ne cascade rien | Router `auth.user.deleted` dans `worker.queue()`                           |
| 5   | S2-006                   | Aucun flow forgot-password / password reset                               | Implémentation slice dédiée                                                |

### HIGH — à traiter avant prod

- **S2-004** Pas de family-tree revoke sur refresh-reuse détecté
- **S2-005** `iss` / `aud` JWT jamais configurés
- **S2-007** `tenantResolver` middleware non monté
- **S2-008** `/v1/auth/refresh` sans rate-limit dédié
- **S3-003** Pas de `bodyLimit` (50 MB acceptés sans limite)
- **S3-005 / S4-003** CORS `dev` reflète n'importe quelle origine avec `credentials:true`
- **S4-004** Outbox flooding par-user — pas de quota
- **S4-005** CSRF non vérifié sur Next.js `/api/auth/refresh`
- **S4-006** Cookie refresh `Path=/` au lieu de `/api/auth`
- **S5-003** Rôle `athlya_cron` non provisionné — anonymisation J+30 inactive
- **S5-004** Pas de hard-delete users après J+30 — rétention illimitée
- **S5-005** Email en clair dans `outbox.payload` — shadow storage
- **S5-006** `export_jobs` jamais purgés
- **S5-007** Throttle Redis stocke `(IP, email)` en clair
- **S6-001** CSP `style-src` strict cassera `style={{}}` React en prod

## Validations positives (à conserver)

Ne pas régresser :

- **JWT** RS256 pinné triple-check (auth/jwt/qr) — algo confusion impossible.
- **bcrypt** cost 12 + timing-safe + dummy hash sur user manquant.
- **HIBP** k-anonymity (préfixe SHA-1 5 chars only).
- **withTenant** + claims regex-validés avant `set_config()`.
- **Toutes les requêtes SQL** paramétrées (drizzle + `sql\`\``).
- **CSP** nonce 128-bit + `strict-dynamic` + `frame-ancestors 'none'`.
- **HSTS** preload + 2 ans + includeSubDomains.
- **Cookies** httpOnly + Secure + SameSite=Lax + nom distinct web/studio.
- **Audit log** trigger immutable + SECURITY DEFINER pinned (search_path, owner, grants).
- **Sentry** body sans request body / headers / cookies.
- **OTel** `user.id` UUID + `studio.id` UUID, pas de PII.
- **Problem Details** 5xx sans stack trace ni `err.message`.
- **Multi-tenant** 404 (pas 403) cross-tenant + 6 tests d'intégration.
- **Stripe webhook** HMAC `crypto.subtle.verify` constant-time + signature redacted.
- **Idempotency** TTL 24h, refresh tokens TTL 30j, export TTL 72h conformes.

## Plan de remédiation suggéré

### Sprint 1 — "Wiring critique" (1 semaine)

Câbler les primitives orphelines. Pas de nouveau code applicatif — pure plomberie.

1. `app.use('/v1/*', rateLimit())` + override `/v1/auth/*` plus strict (S2-001/S3-001/S4-001).
2. `shouldAllowLogin()` dans `auth-deps.ts:login` (S2-001/S4-002).
3. CORS dev → whitelist `localhost:3000/3001` explicite (S3-005/S4-003).
4. `bodyLimit({ maxSize: 256*1024 })` sur `/v1/*` (S3-003).
5. Router `auth.user.deleted` + `members.export.requested` dans `worker.queue()` (S5-001/S5-002).
6. `tenantResolver()` middleware monté + cross-check host vs claim (S2-007).
7. JWT `iss` / `aud` configurés (S2-005).
8. DLQ admin router monté dans `buildApp` (S2-018).

**Effort estimé : 5 jours engineering.**

### Sprint 2 — "Refresh atomicity & RGPD" (1 semaine)

1. `SessionStore.rotate()` réécrit en script Lua Upstash atomique (S2-002).
2. Family-tree revoke sur refresh-reuse détecté + audit (S2-004).
3. Provisionner `CRON_DB_URL` + endpoint anonymisation J+30 (S5-003).
4. Hard-delete users J+30 (S5-004).
5. Purge `outbox` + `export_jobs` (S5-005/S5-006).
6. Cookie refresh `Path=/api/auth` (S4-006).

**Effort estimé : 5 jours engineering.**

### Sprint 3 — "Headers + Hardening" (3 jours)

1. Permissions-Policy + COOP/CORP (S6-002/S6-003/S4-012).
2. CSP `style-src-attr 'unsafe-inline'` ou refacto BrandingPreview (S6-001).
3. `poweredByHeader: false` (S6-004).
4. Origin/Referer check sur Next.js `/api/auth/*` (S4-005/S6-005).
5. CSP report-uri provisionné en staging+prod (S6-006).
6. CORS_ORIGIN requis au boot (S4-014).
7. Host check Worker (S4-015).
8. Distinguer `hibp_unavailable` vs `password_breached` (S2-009).
9. Throttle Redis key hashée (S5-007).
10. Auto-redact logger + ESLint rule (S5-008).

### Sprint 4 — "Forgot password + UX" (1 semaine)

1. Flow forgot-password complet (S2-006).
2. Logout per-device (S2-010).
3. Re-prompt CGU sur changement de version (S5-013).
4. Pages `/privacy` + `/legal` + `/cookies` (S5-014).
5. Bannière cookies préventive (S5-009).
6. Cron sweeper outbox (S5-005).

### Sprint 5 — "Compliance docs" (3 jours, parallel)

1. Runbook `breach-notification.md` (S5-019).
2. DPIA + sous-traitants documentés (S5-011/S5-012).
3. HSTS preload soumission après stabilité (S4-009).
4. DSN Sentry pinned EU au boot (S5-010).
5. Stripe Data Residency EU vérifiée (S5-012).
6. Bumper `postcss` ≥ 8.5.10 + `testcontainers` ≥ 11 (S1-001/S1-003).

## Conclusion

L'application a une **conception sécurité de bonne facture** (cryptographie correcte, RLS, audit log immuable, validation Zod systématique, multi-tenant 404, secrets jamais hardcodés). Le **gap principal n'est pas conceptuel mais opérationnel** : 8 primitives de sécurité existent dans le repo mais ne sont pas branchées en production.

**Recommandation** : exécuter Sprint 1 (5 jours) avant tout déploiement production. Les Sprints 2-3 sont à boucler sur les 2 semaines suivantes. Le reste peut s'étaler avec le launch.

**Score global après Sprint 1 estimé** : ~85 / 100 (élimine les 5 CRITICAL).
**Score global après Sprint 1+2+3** : ~92 / 100.
