# Audit Sécurité S5 — RGPD / GDPR & Data Privacy

Date: 2026-05-15
Périmètre: monorepo Athlya (`packages/api`, `packages/auth`, `packages/members`, `packages/notifications`, `packages/billing`, `packages/db`, `apps/web`, `apps/studio`).
Rappel: l'audit suppose les conditions actuelles (`B7`/`B8` slices, voir `docs/modifications/modifications.md`). Aucun code n'a été modifié pendant l'audit.

---

## Conformité RGPD — vue d'ensemble

| Article | Sujet | Statut |
|---|---|---|
| 13-14 | Information transparente / mentions | ⚠️ Partiel — pas de page Politique / CGU exposée côté `apps/web` (cf. S5-014) |
| 15 | Droit d'accès | 🟠 Implémenté côté logique (`enqueueExport`, `runExportJob`) mais **consumer non câblé en prod** (cf. S5-001 [PROD-BLOCKER]) |
| 16 | Rectification | ✅ `PATCH /v1/members/me` + `PATCH /v1/members/me/consents` |
| 17 | Effacement | 🟠 `DELETE /v1/auth/me` soft-delete OK, **cascade consumer non câblé** (cf. S5-002 [PROD-BLOCKER]) |
| 20 | Portabilité | ✅ format ZIP JSON+CSV (Req 4.4) — bloqué par S5-001 |
| 21 | Opposition | 🟡 `consents.marketing` respecté par `notifications/consumer.ts` (Req 17.1/17.2) — pas de marketing emails actifs aujourd'hui |
| 25 | Privacy by design | 🟢 RLS, immutabilité audit_log, projection `MemberProfile` (pas de `password_hash`), schémas Zod stricts |
| 32 | Sécurité du traitement | 🟢 chiffrement transport TLS, hashage bcrypt, JWT RS256 — voir audits S2/S4 |
| 33-34 | Notification breach | ⚠️ Pas de runbook formalisé `docs/runbooks/breach-notification.md` (cf. S5-019) |

---

## Résumé exécutif

| Sévérité | Findings |
|---|---|
| **CRITICAL** | 2 |
| HIGH | 4 |
| MEDIUM | 6 |
| LOW | 5 |
| INFO | 3 |
| **Total** | **20** |

**Score conformité RGPD : 62 / 100.**

Détail :
- **Article 17 (effacement) : 4 / 20** — la machinerie cascade existe (`handleUserDeleted`, `anonymizeAuditLog`) et est unit-testée + intégration Postgres. Mais le `worker.ts` n'a **aucun branchement queue → cascade**. Le `DELETE /v1/auth/me` produit un `auth.user.deleted` qui transite par l'outbox, est livré sur Cloudflare Queues, mais aucune fonction `queue()` ne le route vers `handleUserDeleted`. Résultat : reservations / workout_sessions / push_tokens / R2 avatar **persistent après "suppression"**. Bloquant prod.
- **Article 15 (accès) : 7 / 20** — même problème : `runExportJob` n'est appelé par aucun consumer en prod. Le `POST /v1/members/me/export` insère bien un `pending` dans `export_jobs`, publie `members.export.requested`, mais le ZIP n'est jamais assemblé. L'utilisateur reste en attente perpétuelle. Bloquant prod.
- **Article 13-14 : 5 / 10** — pas de page Politique de confidentialité publique (`/privacy`, `/legal`, `/cookies`). Le formulaire d'inscription demande consentement aux trois flags mais ne renvoie vers aucun document légal.
- **Sécurité du traitement (Art 32) : 28 / 30** — bon socle (RLS forcée, audit log triggers + SECURITY DEFINER pinned, hashage, TLS). Quelques bémols documentés ci-dessous.
- **Privacy by design (Art 25) : 18 / 20** — solid : pas de PII dans les Sentry envelopes, OTel spans = `user.id`/`studio.id` uniquement, projection profile sans `password_hash`. Petit reproche : le payload de l'événement `auth.user.registered` carry `email` brut dans la table `outbox` JSONB (cf. S5-008).

---

## Findings

### S5-001 [CRITICAL] [PROD-BLOCKER] [PROD-RISK] L'export RGPD n'est jamais exécuté en production — `runExportJob` non câblé sur la queue Cloudflare

- **Article RGPD** : 15 (droit d'accès), 20 (portabilité), 12 §3 (réponse sous 1 mois)
- **Localisation** :
  - producer : `packages/api/src/routes/members.ts:165-178` (POST /v1/members/me/export)
  - producer service : `packages/members/src/export.ts:483-541` (`enqueueExport`)
  - consumer attendu : `packages/members/src/export.ts:571-657` (`runExportJob`)
  - `packages/api/src/worker.ts:436-457` (handler `queue(...)`)
- **Description** : `enqueueExport` insère bien une ligne dans `export_jobs(status='pending')` et publie un `members.export.requested` sur l'outbox → drain → `EVENTS_QUEUE`. Mais le `queue()` handler du Worker ne route **que** la queue `athlya-events-dlq` ; tous les autres messages — y compris `members.export.requested` — tombent dans la branche silencieuse "/* Other queue consumers ... */" (worker.ts:451-456). Aucun appel à `runExportJob` n'existe dans `packages/api/src/**`.
- **Scénario** : un utilisateur invoque `POST /v1/members/me/export` → reçoit `202 { jobId }` → `GET /v1/members/me/export/:jobId` (s'il existait) renverrait éternellement `status: 'pending'`. Le ZIP n'est jamais assemblé, jamais uploadé sur R2, le membre n'est jamais notifié.
- **Impact privacy** : non-respect Art 12§3 — le responsable de traitement doit fournir l'export "dans les meilleurs délais et au plus tard dans un délai d'un mois". Une plainte CNIL après 30 jours sans export est mécaniquement gagnante.
- **Mitigation** :
  1. Ajouter dans `worker.ts:queue()` une branche `if (batch.queue === 'athlya-export-jobs')` qui parse l'envelope, extrait `jobId`, et appelle `runExportJob(jobId, deps)` avec un `RunExportJobDeps` câblant Drizzle, R2 (`AVATARS_BUCKET` ou un nouveau binding `EXPORTS_BUCKET`), QStash, et un fflate-backed `ArchiveBuilder`.
  2. Alternative : QStash webhook (`/v1/internal/qstash/export`) avec vérification de signature `Upstash-Signature`.
  3. Tester en intégration que le jobId passe bien en `completed` après livraison de la queue.
- **Effort** : 1 jour (binding R2 + adapter `MemberDataSource` → Drizzle + intégration `archive` via `fflate`).

---

### S5-002 [CRITICAL] [PROD-BLOCKER] [PROD-RISK] La cascade RGPD de suppression n'est jamais exécutée en production — `handleUserDeleted` non câblé sur la queue

- **Article RGPD** : 17 (droit à l'effacement), 5§1.e (limitation de conservation)
- **Localisation** :
  - service : `packages/auth/src/service.ts:1047-1067` (`deleteMe`)
  - consumer attendu : `packages/members/src/cascade.ts:265-295` (`handleUserDeleted`)
  - `packages/api/src/worker.ts:436-457` (handler `queue(...)`)
- **Description** : `deleteMe` fait correctement (a) soft-delete `users.deleted_at = now()`, (b) `revokeAllForUser` Redis, (c) publish `auth.user.deleted` via outbox. Le drain pousse l'event sur `EVENTS_QUEUE`. Mais aucune branche `queue()` ne dispatche `auth.user.deleted` vers `handleUserDeleted`. Conséquences :
  - `reservations` du user **restent en base** (FK sur `users` oui, mais le row `users` reste, donc pas de cascade FK)
  - `workout_sessions` **restent en base**
  - `push_tokens` **restent en base** → notifications continuent d'être envoyées au device
  - avatar R2 **reste stocké**
  - aucune anonymisation J+30 n'est planifiée car la `Scheduler.scheduleAnonymization` n'est jamais invoquée
- **Scénario** : un utilisateur supprime son compte → reçoit 200 → la PWA ne peut plus se connecter (sessions Redis révoquées, `users.deletedAt !== null` bloque login en service.ts:786) → mais ses bookings sont toujours visibles côté admin/coach via `GET /v1/members` (avec `WHERE deletedAt IS NULL` qui les exclut, OK), et ses workout_sessions restent indéfiniment, son avatar idem.
- **Impact privacy** : non-respect Art 17§1 ("la personne concernée a le droit d'obtenir … l'effacement, dans les meilleurs délais"). La CNIL inflige des amendes proportionnelles au volume — typiquement quelques dizaines de milliers d'euros pour une SaaS multi-tenant.
- **Mitigation** :
  1. Dans `worker.ts:queue()`, ajouter le routing par event type. Pour `auth.user.deleted` → `handleUserDeleted(event, depsCascade)`.
  2. Wirer le `Scheduler.scheduleAnonymization` sur un client Upstash QStash → publish JSON avec `notBefore = now+30d` ciblant un endpoint `/v1/internal/qstash/anonymize-audit` qui appelle `anonymizeAuditLog`.
  3. Tester en intégration end-to-end : DELETE /v1/auth/me → outbox → drain → queue → cascade → assertion sur les counts `reservations / sessions / pushTokens` et sur `users.deleted_at IS NOT NULL`.
- **Effort** : 1.5 jour (binding QStash + adapter `DeletionRepo` Drizzle + adapter `AvatarStore` R2).

---

### S5-003 [HIGH] [PROD-RISK] Aucune planification ni exécution de l'anonymisation J+30 du `audit_log`

- **Article RGPD** : 5§1.e (limitation conservation), 17§1
- **Localisation** :
  - SQL : `packages/db/migrations/0003_audit_anonymization.sql:188-216` (`anonymize_user_audit`)
  - consumer : `packages/members/src/cascade.ts:345-353` (`anonymizeAuditLog`)
- **Description** : la fonction Postgres `anonymize_user_audit(target_user uuid)` est en place, correctement durcie (SECURITY DEFINER, `search_path = public, pg_temp`, `OWNER athlya_owner BYPASSRLS`, `EXECUTE` granted only to `athlya_cron`), trigger `audit_log_immutable()` autorise l'`athlya_owner`, etc. Mais aucune connexion Postgres ne se fait avec le rôle `athlya_cron` aujourd'hui : la variable `DB_URL` du Worker pointe sur `athlya_app`. Il n'existe pas de second binding (`MIGRATION_DB_URL` est privileged mais c'est pour les migrations, pas pour le cron applicatif). Conséquence : même si S5-002 est résolu, l'anonymisation Audit n'aura pas de chemin d'exécution.
- **Scénario** : l'`audit_log` continue de stocker `actor_id`, `metadata.email`, `metadata.userAgent` indéfiniment — y compris pour les utilisateurs supprimés.
- **Impact privacy** : violation directe de Req 5.3 + Art 5§1.e (durée de conservation limitée). Aggrave S5-002.
- **Mitigation** :
  1. Provisionner un binding secret `CRON_DB_URL` pointant sur un user Postgres rôle `athlya_cron` (déjà créé par 0003_audit_anonymization.sql).
  2. Dans le Worker `scheduled()` ou via un endpoint `/v1/internal/qstash/anonymize-audit`, ouvrir une connexion Drizzle sur `CRON_DB_URL`, exécuter `SELECT anonymize_user_audit($1)`.
  3. Tester avec l'intégration `cascade.integration.test.ts` (qui utilise déjà testcontainers + le rôle cron).
- **Effort** : 4 h.

---

### S5-004 [HIGH] [PROD-RISK] Pas de hard-delete des utilisateurs soft-deleted — les rows `users` persistent indéfiniment

- **Article RGPD** : 5§1.e, 17§1
- **Localisation** :
  - `packages/auth/src/service.ts:1047-1067` (`deleteMe` ne fait que soft-delete)
  - `packages/members/src/cascade.ts:317-323` (`markUserDeleted` re-stamp idempotent)
  - aucun hard-delete dans le repo `auth-user-repo-drizzle.ts`
- **Description** : la spec (Req 5.1, 5.4) parle d'une fenêtre de 30 jours après laquelle le row `users` doit être hard-deleted (cf. tasks.md "after 30-day grace window"). Aujourd'hui :
  - `deleteMe` flippe `deleted_at = now()`
  - le cascade consumer (S5-002) flippe encore `deleted_at` (idempotent) puis `scheduleAnonymization(dueAt = now+30d)`
  - le job J+30 anonymise l'audit (`actor_id = NULL`, strip metadata) **mais ne supprime pas le row `users`**
- **Scénario** : un utilisateur supprime son compte → 30 jours plus tard l'audit est anonymisé → mais `users.email` (citext), `users.display_name`, `users.avatar_url`, `users.consents` restent en base **ad vitam**. Note : `password_hash` n'est pas un PII brut mais reste un secret persistant.
- **Impact privacy** : data minimization violation. La spec Req 5.4 attend un hard-delete sous 30j ; aujourd'hui c'est 0 % implémenté.
- **Mitigation** :
  1. Étendre `anonymizeAuditLog` (ou créer un `hardDeleteUserRow`) qui après J+30 fait `DELETE FROM users WHERE id = $1 AND deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days'`.
  2. Documenter le choix : "récupération de compte sous J+30" → est-ce réversible ? (la spec ne le dit pas mais Req 5.1 parle de `delete_at = now()` immédiat, donc le compte est inutilisable dès le clic). Si oui, un endpoint `/v1/auth/me/undelete` pour les 30 premiers jours est cohérent.
  3. Alternative pragmatique : à la place du hard-delete, anonymiser le row : `email = NULL`, `display_name = '[deleted]'`, `avatar_url = NULL`, `consents = '{}'`. Garder l'`id` comme tombstone pour les FK historiques (réservations conservées).
- **Effort** : 6 h.

---

### S5-005 [HIGH] [PROD-RISK] Le payload `auth.user.registered` carry `email` en clair dans la table `outbox` (JSONB) — pas d'anonymisation

- **Article RGPD** : 5§1.c (minimisation), 5§1.e
- **Localisation** :
  - schema : `packages/shared/src/events.ts:165-175` (`AuthUserRegisteredEventSchema` payload `{ userId, email }`)
  - producer : `packages/auth/src/service.ts:478-499` (`buildUserRegisteredEvent`)
  - persistance : table `outbox` (`packages/db/migrations/0000_init.sql:103-115`) — colonne `payload jsonb`
- **Description** : à chaque registration, l'event `auth.user.registered` est inséré dans `outbox(payload jsonb)` avec `email: "alice@example.com"` en clair. Une fois publié sur la queue, `published_at` est stamped — mais la **row n'est jamais supprimée**. Aucun job de purge `DELETE FROM outbox WHERE published_at < now() - interval 'X'`. Donc l'email persiste indéfiniment dans `outbox.payload`, **même après un `DELETE /v1/auth/me`**.
- **Scénario** : un user se supprime → cascade S5-002 résolue → `users.email` purgé (cf. S5-004) → mais l'`outbox.payload->>'email'` reste accessible à tout DBA / leak / backup.
- **Impact privacy** : violation Art 5§1.e. Aggravation du shadow-storage : la table `outbox` n'est mentionnée nulle part dans le DPIA / liste des sous-traitants.
- **Mitigation** :
  1. Soit retirer `email` du payload `auth.user.registered` (le consumer `notifications` a déjà accès à l'email via `RecipientRepo.getRecipient(userId)`, donc l'email dans le payload est redondant).
  2. Soit ajouter un job cron `DELETE FROM outbox WHERE published_at IS NOT NULL AND published_at < now() - interval '7 days'`.
  3. Soit étendre le cascade J+30 pour faire aussi `UPDATE outbox SET payload = jsonb_strip_nulls(payload - 'email') WHERE payload->>'userId' = $1`.
- **Effort** : 2 h pour l'option (1) (recommandée).

---

### S5-006 [HIGH] [PROD-RISK] Aucune politique de rétention sur `export_jobs` — les URLs signées + métadonnées restent ad vitam

- **Article RGPD** : 5§1.e
- **Localisation** : `packages/db/migrations/0002_export_jobs.sql:32-49` — pas de TTL, pas d'index `expires_at`
- **Description** : la table `export_jobs` stocke `download_url` (URL R2 signée) + `download_expires_at` (= now+72h). Une fois la 72h passée, la row reste en base avec une URL "morte" mais traçable. Aucun cron ne purge.
- **Scénario** : 1 an plus tard, un dump SQL leak → un attaquant peut corréler `userId ↔ export R2 path ↔ historique de demandes RGPD`. Surface d'analyse temporelle (un user qui demande un export tous les mois ≠ un user passif).
- **Impact privacy** : minimisation (Art 5§1.c). Faible impact direct mais shadow-storage typique.
- **Mitigation** :
  1. Cron daily : `DELETE FROM export_jobs WHERE status IN ('completed', 'failed') AND requested_at < now() - interval '90 days'`. 90 jours pour permettre un audit support.
  2. À la même occasion, R2 `lifecycle rule` `expires_after = 72h` sur le prefix `exports/members/*` (déjà ce qu'attend le download URL TTL).
- **Effort** : 2 h.

---

### S5-007 [HIGH] [PROD-RISK] Le throttle login Redis stocke `(IP, email)` en clair comme clé

- **Article RGPD** : 5§1.c, 32§1.a (pseudonymisation)
- **Localisation** : `packages/auth/src/throttle.ts:149-153` (`loginBucketKey`) → format `auth:login:<ip>:<email>`
- **Description** : la clé Redis est `auth:login:1.2.3.4:alice@example.com`. Upstash conserve la clé en mémoire avec TTL = 15 min, mais la combinaison **IP + email** est très identifiante. Un dump Redis (ou un export Upstash) leak directement le couple "qui a essayé de se connecter depuis quelle IP".
- **Scénario** : (a) dump Redis ; (b) attaquant interne Upstash ; (c) command-injection Lua ratée : tous mènent à un leak couplé.
- **Impact privacy** : la CNIL recommande explicitement la pseudonymisation des identifiants stockés en cache pour l'anti-abuse. cf. doctrine "Vie Privée 4 — Authentification".
- **Mitigation** :
  1. Hasher la clé : `auth:login:${sha256(ip + ':' + email).slice(0, 24)}`. Garde l'unicité de la (IP, email) sans révéler les valeurs.
  2. Bonus : utiliser HMAC avec un secret stable (`HASH_PEPPER`) pour empêcher des collisions/rainbow.
- **Effort** : 30 min (changer `loginBucketKey` + adapter les tests).
- **Note** : ce finding s'aggrave si la mesure de S4-002 (câbler effectivement `shouldAllowLogin` sur `/v1/auth/login`, qui n'est pas branché aujourd'hui) est appliquée — sans cette correction préalable la clé n'est jamais écrite.

---

### S5-008 [MEDIUM] [PROD-RISK] Le helper `redactKeys` du logger n'est jamais invoqué — opt-in non utilisé

- **Article RGPD** : 32§1.a
- **Localisation** : `packages/api/src/logging.ts:81-104`
- **Description** : `redactKeys(['password', 'token', 'authorization', 'stripeSignature', 'secret'])` est exporté et bien testé, mais **aucun call site dans `packages/**`** ne l'utilise. Tous les `logger.info(...)` ajoutent leurs champs en confiance. Aujourd'hui, par chance, aucun appel n'inclut un mot de passe ou un token complet (cf. observations détaillées : `served` log = method/path/status/durationMs/traceId, `idempotency` log = key/userId, `turnstile` = traceId only). Mais l'absence de discipline programmatique signifie qu'une future PR peut introduire `logger.info('login attempt', { email })` ou similaire **sans CI guardrail**.
- **Impact privacy** : risque latent de leak vers Tail Workers / Logpush. Une fois envoyé sur Logpush S3, la donnée est hors RGPD-anonymizable.
- **Mitigation** :
  1. Wrapper `createLogger(...)` pour appliquer `redactKeys(DEFAULT_REDACTED_KEYS)` à chaque emit, en autopilote. Brisera certains tests qui assertent l'absence d'auto-redaction — à mettre à jour.
  2. Ajouter une règle ESLint custom : interdire les littéraux de chaînes correspondant à `/email|password|token|authorization/i` à droite du `:` dans un `logger.<level>({ ... })`.
- **Effort** : 1 h.

---

### S5-009 [MEDIUM] [PROD-RISK] Pas de bannière de cookies / consent banner côté `apps/web`

- **Article RGPD** : 7§1, ePrivacy Directive 2009/136/CE
- **Localisation** : `apps/web/src/app/layout.tsx`, aucun composant `CookieBanner.tsx`, aucun import `tarteaucitron`/`cookiebot`/`onetrust`
- **Description** : actuellement aucune SDK analytics / tracking n'est chargée dans `apps/web` ou `apps/studio`. Donc *de facto* aucun cookie tiers n'est déposé et aucune bannière n'est nécessaire au sens strict de l'ePrivacy Directive. Mais :
  - dès qu'on ajoutera `@sentry/browser` ou `posthog-js` ou `plausible-script` (déjà mentionnés dans `project.md` § "Sous-traitants"), la bannière deviendra obligatoire AVANT le chargement de ces SDK.
  - le cookie `LOCALE` (technique strict) n'a pas besoin de consent — OK.
  - le cookie `refresh` (auth strict) n'a pas besoin non plus — OK.
- **Scénario** : feature creep "ajout Plausible pour mesurer le funnel d'inscription" → SDK chargé sans consent → CNIL Art 82 Loi I&L. Amende type Carrefour (5 M€).
- **Impact privacy** : zéro aujourd'hui, élevé dès le premier ajout d'analytics.
- **Mitigation** :
  1. Bloquer l'ajout de toute SDK analytics tant qu'un `<CookieBanner />` n'est pas mergé.
  2. Implémenter `<CookieBanner />` qui (a) bloque les SDK non-essentiels par défaut, (b) lit `consents.analytics` côté client via le store auth → si `false`, ne charge rien, (c) propose 3 boutons (Accepter / Refuser tout / Personnaliser) per CNIL Lignes Directrices 2020-091.
  3. Documenter dans `docs/runbooks/cookie-policy.md`.
- **Effort** : 1 jour quand le besoin se présente.

---

### S5-010 [MEDIUM] [PROD-RISK] Le DSN Sentry n'a pas de pin EU côté code — risque de configuration accidentelle US

- **Article RGPD** : 44 (transferts hors UE), 46 (clauses types)
- **Localisation** : `packages/api/src/sentry.ts:178-208` (`parseDsn`)
- **Description** : `parseDsn` accepte n'importe quel DSN HTTPS. Le code ne vérifie pas que le `host` correspond à `*.eu.sentry.io` ou `o*.ingest.eu.sentry.io`. Si un opérateur configure `SENTRY_DSN=https://xxx@o123.ingest.us.sentry.io/456` par erreur, **les exceptions partent aux US** — incluant `err.message` qui peut leak des informations métier (et un `traceId` corrélable avec les access logs).
- **Scénario** : incident → on copie un DSN trouvé sur le tableau de bord de la mauvaise organisation → trafic d'erreurs vers ingestion US sans Standard Contractual Clauses. Article 44 violation.
- **Impact privacy** : transfert international non encadré.
- **Mitigation** :
  1. Dans `parseDsn`, après construction, vérifier `url.host.endsWith('.eu.sentry.io')` (ou liste explicite). Si non match → retourner `null` (le client devient no-op) + `console.error('SENTRY_DSN host not in EU allowlist; capture disabled')`.
  2. Documenter dans `wrangler.toml.example` la valeur attendue.
- **Effort** : 30 min.

---

### S5-011 [MEDIUM] [PROD-RISK] Cloudflare Workers Smart Placement ≠ region pin EU — `wrangler.toml` reconnaît la limite

- **Article RGPD** : 44, 46, Req 5.5
- **Localisation** : `packages/api/wrangler.toml:31-40`, `:228-232`
- **Description** : le commentaire de `wrangler.toml` est lucide :
  > Smart Placement is NOT a hard EU-only region pin. A dedicated EU region constraint requires a Workers Enterprise contract and a separate `compatibility_flags = ["region_exclusive_eu"]` entry — that is NOT in scope.
  
  Conséquence : un Worker peut être instancié hors UE (notamment lors des bursts / cold-start failovers). Le code applicatif s'exécute alors hors UE, même si Postgres/Redis sont EU.
- **Scénario** : un utilisateur depuis Tokyo déclenche un cold-start → l'isolat Worker tourne potentiellement à Tokyo → `req.body` (login email + password) transite par RAM Tokyo avant de POST vers Neon Frankfurt. L'exécution-en-RAM "transit" est juridiquement floue mais l'EDPB tend à le considérer comme transfert.
- **Impact privacy** : risque résiduel — l'EDPB consider que les fournisseurs CDN avec POPs mondiaux ne traitent pas "réellement" en dehors de l'UE tant que le payload n'y séjourne pas. Le débat est ouvert (cf. Schrems II).
- **Mitigation** :
  1. Souscrire un contrat Workers Enterprise + activer `compatibility_flags = ["region_exclusive_eu"]`. Coût : significatif (~$5k/mois).
  2. Court-terme : DPIA documentant l'exposition + clauses contractuelles standard avec Cloudflare (existantes via leur DPA générique).
  3. Documenter dans `project.md` § "Sous-traitants" la limite explicite.
- **Effort** : 0 code, 4h documentaire.

---

### S5-012 [MEDIUM] [PROD-RISK] Stripe — pas de pin EU dans la configuration billing

- **Article RGPD** : 44
- **Localisation** : `packages/billing/src/service.ts`, pas de référence à `Stripe-Account` EU ou à un mode "data residency EU"
- **Description** : Stripe propose depuis 2023 une option "Data Residency EU" (Stripe Europe Limited) qui garantit le stockage en Irlande. Sans cette opt-in, les `customer`, `subscription`, `invoice` sont stockés aux US. Les webhooks reçoivent des `customer_email`, `metadata.userId`, `metadata.studioId` — donc des PII identifiants.
- **Scénario** : compte Stripe créé via signup standard → infrastructure US par défaut → conformité Schrems II non couverte.
- **Impact privacy** : transfert non couvert. Faible si le contrat Stripe est leur DPA + Standard Contractual Clauses (publiques) — mais à documenter.
- **Mitigation** :
  1. Vérifier sur le dashboard Stripe que l'option "Data Residency: Europe" est activée.
  2. Documenter dans `project.md` § "Sous-traitants" : `Stripe Payments Europe Ltd, Dublin, IE`.
- **Effort** : 0 code, 1 h documentaire.

---

### S5-013 [MEDIUM] [PROD-RISK] Pas de versioning re-prompt côté client lorsqu'un user a accepté une CGU obsolète

- **Article RGPD** : 7§1, 13
- **Localisation** : `packages/members/src/consents.ts:62-67` (`CURRENT_CGU_VERSION = '2026-01'`)
- **Description** : `updateConsents` stamp bien la version courante côté serveur. `GET /v1/members/me` renvoie `consents.version` au client. Mais aucun composant côté `apps/web` ou `apps/studio` ne compare `consents.version < CURRENT_CGU_VERSION` et n'affiche un re-prompt obligatoire avant d'autoriser les actions sensibles.
- **Scénario** : la version CGU passe de `2025-06` à `2026-01` (par bump du constant) → les utilisateurs existants gardent leurs consentements à `2025-06` → ils continuent d'utiliser l'app sans avoir vu la nouvelle version → consentement non renouvelé.
- **Impact privacy** : Art 7§3 — le consentement doit être "aussi facile à retirer qu'à donner" et lié à une **information** courante.
- **Mitigation** :
  1. Côté `apps/web`, après login, lire `consents.version`. Si `< CURRENT_CGU_VERSION` (exposer la constante via `/v1/config` ou via un endpoint dédié), afficher un modal bloquant `<ConsentRefreshModal />` qui montre le diff CGU et demande re-acceptation.
  2. Tracer l'action dans `audit_log` (`user.consents.updated` avec `previousVersion`).
  3. Idem côté mobile.
- **Effort** : 1 jour.

---

### S5-014 [MEDIUM] [PROD-RISK] Pas de page `/privacy` ni `/legal` exposée — Article 13-14 non couvert UI

- **Article RGPD** : 13 (information collecte), 14 (information indirect)
- **Localisation** : aucune route `/privacy` / `/legal` / `/cookies` / `/dpa` dans `apps/web/src/app/**`
- **Description** : le formulaire de registration (`apps/web/src/app/register/RegisterForm.tsx`) demande consentement à 3 flags (`marketing`, `analytics`, `thirdParty`) avec des labels traduits, mais aucun lien vers une page de politique de confidentialité décrivant : finalités de traitement, durées de conservation, sous-traitants, droits de la personne, coordonnées DPO. Pareil pour `apps/studio`.
- **Scénario** : audit CNIL dérive un dossier sur "consentement non éclairé" Art 4§11 ("pour autant que la personne en soit dûment informée").
- **Impact privacy** : information transparente non garantie.
- **Mitigation** :
  1. Créer `apps/web/src/app/(legal)/privacy/page.tsx`, `(legal)/terms/page.tsx`, `(legal)/cookies/page.tsx`, contenus traduits (FR primary, EN fallback) hébergés en MDX.
  2. Ajouter un footer global avec liens vers les 3 pages.
  3. Linker depuis le `RegisterForm.tsx` ("J'ai lu la <a>politique de confidentialité</a>").
- **Effort** : 2 jours (rédaction légale + intégration). Préférer un cabinet spécialisé pour le contenu.

---

### S5-015 [LOW] [PROD-RISK] L'export n'inclut pas les invoices Stripe lorsque `BillingService` est en mode dégradé

- **Article RGPD** : 20 (portabilité)
- **Localisation** : `packages/members/src/export.ts:239-245` (`MemberDataSource.listInvoices`)
- **Description** : `MemberDataSource.listInvoices` est défini mais l'adapter Drizzle (qu'il faudra créer pour S5-001) devra appeler le BillingService. Si BillingService est en mode dégradé (Stripe non provisionné, cf. `apps/studio/src/app/dashboard/billing/BillingPlansClient.tsx`), `listInvoices` retournera `[]`. L'export ZIP sera "vide" sur cette dimension sans le signaler à l'utilisateur.
- **Impact privacy** : un membre peut croire que son export est complet alors qu'il manque ses factures.
- **Mitigation** : ajouter dans le ZIP un `README.md` listant explicitement chaque collection ET le statut (`included` / `unavailable: Stripe not configured` / `empty: no records`).
- **Effort** : 1 h.

---

### S5-016 [LOW] [PROD-RISK] L'archive d'export ne contient pas le `studio` ni le `displayName` du studio — corrélations difficiles côté membre

- **Article RGPD** : 20
- **Localisation** : `packages/members/src/export.ts:84-93` (`ExportProfile`)
- **Description** : `ExportProfile` carry uniquement `studioId` (UUID opaque). Le membre récepteur n'a pas le `studio.name` / `studio.slug`. Si le membre a fréquenté plusieurs studios (multi-account), la portabilité Art 20 est gênée.
- **Mitigation** : enrichir l'export avec `studio.json` contenant `{ id, name, slug, brandColor }` du studio courant.
- **Effort** : 30 min.

---

### S5-017 [LOW] [PROD-RISK] L'audit anonymization ne purge pas la clé `subjectUserId` du metadata — réversibilité partielle

- **Article RGPD** : 5§1.c
- **Localisation** : `packages/db/migrations/0003_audit_anonymization.sql:198-211`
- **Description** : la requête anonymization fait `metadata - 'email' - 'displayName' - 'ip' - 'userAgent'`, mais préserve `subjectUserId`. Justification dans le commentaire SQL : "Non-PII keys such as `subjectUserId` themselves … are preserved so the row stays useful for forensics". Or `subjectUserId` est par définition l'UUID **de l'utilisateur supprimé**. C'est un identifiant indirect qui, croisé avec un autre dataset (réservations futures réutilisant l'UUID — non, les UUID v4 ne se réutilisent pas, mais un dump SQL intermédiaire pourrait), permet de re-identifier.
- **Impact privacy** : très faible (UUID v4 est aléatoire, non corrélable hors base) mais c'est de la sur-conservation par rapport au minimum nécessaire.
- **Mitigation** : optionnel — soit accepter (UUID opaque), soit purger aussi la clé. Si purgée, ajouter une clé `subjectAnonymized: true` pour préserver l'analyse forensique "il y a eu une action sur un user supprimé".
- **Effort** : 15 min, controversé.

---

### S5-018 [LOW] [DEV-ONLY] Les tests d'intégration cascade utilisent `console.warn` non-mocké — pas un vrai problème

- **Article RGPD** : N/A
- **Localisation** : `packages/members/tests/integration/cascade.integration.test.ts:545-551`
- **Description** : les tests intégrations affichent des warnings sur `console.warn` quand Docker est down. Pas un risque de PII leak en prod.
- **Mitigation** : aucune action requise.

---

### S5-019 [LOW] [PROD-RISK] Pas de runbook formalisé `breach-notification.md` (Art 33-34)

- **Article RGPD** : 33 (notification CNIL 72h), 34 (notification personnes concernées)
- **Localisation** : `docs/runbooks/` ne contient pas `breach-notification.md`
- **Description** : Art 33 oblige à notifier la CNIL "dans les meilleurs délais et, si possible, 72 heures au plus tard après en avoir pris connaissance". Sans runbook, le studio risque de dépasser le délai en cas d'incident.
- **Mitigation** : créer `docs/runbooks/breach-notification.md` avec :
  - critères de détection (ex : pgAudit + Sentry alerts spécifiques)
  - décisionnel "incident → breach RGPD ? matrice Art 4§12"
  - template formulaire CNIL en ligne
  - template email de notification aux personnes (Art 34 §2)
  - liste des contacts (DPO, juridique, CTO)
- **Effort** : 1 jour rédaction.

---

### S5-020 [INFO] [PROD-RISK] Bonnes pratiques observées (à conserver)

À documenter en ligne de référence pour ne pas les régresser :

- **Audit log triggers** (`packages/db/migrations/0000_init.sql:206-227`) : `audit_log_immutable()` + triggers `BEFORE UPDATE/DELETE` raise systématique. Bypass UNIQUEMENT via le rôle `athlya_owner` (`0003_audit_anonymization.sql:115-132`).
- **SECURITY DEFINER pinned** : `anonymize_user_audit` a `SET search_path = public, pg_temp` (anti-search-path-hijacking), `OWNER athlya_owner` (BYPASSRLS), `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO athlya_cron`. Capability-style grant exemplaire.
- **Sentry sanitization** : `toExceptionPayload` n'envoie que `err.name` + `err.message`. Pas de `request.body`, pas de `headers`, pas de `cookies`. cf. `packages/api/src/sentry.ts:255-273`.
- **OTel sanitization** : spans portent `studio.id`, `user.id` (UUIDs) et `http.route` (template, pas raw URL avec query). Pas d'`http.request.body`. cf. `packages/api/src/middleware/otel.ts:679-688`.
- **Notifications consent gating** : `handleEvent` lit `recipient.consents.marketing` AVANT d'envoyer, transactional events (`reservation.*`, `billing.subscription.failed`) bypassent correctement (Req 17.2). Architecture extensible via `TRANSACTIONAL_KIND` + `deps.isTransactional` override pour tests. cf. `packages/notifications/src/consumer.ts:567-586`.
- **Members repo projection** : `toMemberProfile` dropbe explicitement `password_hash` et `deleted_at`. Garde-fou statique TS dans `buildUpdatePatch`. cf. `packages/api/src/adapters/members-repo-drizzle.ts:148-166`.
- **Problem Details secret-leak guard** : 5xx body utilise `about:blank` + `traceId` uniquement, jamais `err.message` ni `err.stack`. cf. `packages/api/src/middleware/problem-details.ts:317-326`.
- **Idempotency keys TTL** : 24h conformes Req 20.2 (`packages/api/src/middleware/idempotency.ts:45`).
- **Refresh tokens** : 30 jours conformes Req 2.2 (`packages/auth/src/jwt.ts:72`).
- **Export download URLs** : 72h conformes Req 4.2 (`packages/members/src/export.ts:54`).
- **Logger sécurisé contre crash** : `safeStringify` + `[logger] JSON serialise failed` fallback empêchent un payload pathologique de crasher le Worker.
- **Versioning consents** : stamp serveur uniquement (`updateConsents:226-228`), client ne peut pas forger de version.
- **Audit append défaillance ≠ rollback consent** : `updateConsents` log `warn` si l'audit échoue, mais ne masque pas l'update. Compromis explicite documenté.

---

## Score conformité RGPD détaillé (sur 100)

| Axe | Pondération | Score |
|---|---|---|
| Art 13-14 (information) | 10 | 5 |
| Art 15 (accès) | 20 | 7 |
| Art 16 (rectification) | 5 | 5 |
| Art 17 (effacement) | 20 | 4 |
| Art 20 (portabilité) | 5 | 4 |
| Art 21 (opposition) | 5 | 5 |
| Art 25 (privacy by design) | 10 | 9 |
| Art 32 (sécurité du traitement) | 15 | 14 |
| Art 33-34 (breach notif) | 5 | 3 |
| Art 44-46 (transferts UE) | 5 | 3 |
| **Total** | **100** | **62** |

---

## Top 3 priorités absolues avant production

1. **[PROD-BLOCKER] Câbler le consumer de la cascade RGPD (`handleUserDeleted`) sur `worker.queue()`** (S5-002).
   La machinerie existe à 100 % en logique métier + intégration Postgres (cf. `packages/members/tests/integration/cascade.integration.test.ts`). Il manque ~ 80 lignes dans `worker.ts` pour parser le batch, dispatcher par event type, et invoquer `handleUserDeleted` avec un `DeletionRepo` Drizzle, un `AvatarStore` R2 et un `Scheduler` QStash. **Sans cette pièce, l'application est non conforme Art 17 RGPD.**

2. **[PROD-BLOCKER] Câbler le consumer du job d'export RGPD (`runExportJob`)** (S5-001).
   Symétrique à la priorité 1. Les utilisateurs qui invoquent l'export reçoivent un `jobId` qui ne sera jamais résolu. Implique aussi la priorité 3 (provisionner le binding R2 d'export et l'archive builder fflate-backed).

3. **[PROD-RISK] Provisionner et utiliser le rôle Postgres `athlya_cron` + endpoint d'anonymisation J+30** (S5-003 + S5-004).
   La migration `0003_audit_anonymization.sql` a tout préparé côté SQL (rôles, function, EXECUTE grant). Manque uniquement (a) un `CRON_DB_URL` secret pointant sur `athlya_cron`, (b) un endpoint protégé qui appelle `SELECT anonymize_user_audit($1)` + un éventuel `DELETE FROM users WHERE deleted_at < now() - interval '30 days'` (cf. S5-004). Sans cette pièce, la rétention illimitée de PII dans `audit_log.metadata` (`email`, `userAgent`, `ip`) est une violation Art 5§1.e.

---

## Annexes

### A. Périmètre testé

- Lecture du code, pas d'exécution dynamique.
- Audit transversal sur `packages/api/`, `packages/auth/`, `packages/members/`, `packages/notifications/`, `packages/billing/`, `packages/db/migrations/`, `packages/shared/src/schemas/`, `apps/web/src/`, `apps/studio/src/`.
- Cross-référence avec `docs/security/audit-S2-auth.md`, `audit-S3-dast.md`, `audit-S4-network.md`, `audit-S6-frontend.md`.
- Cross-référence avec `project.md` § "Sous-traitants" et `README.md` § "Résidence EU".

### B. Limitations de l'audit

- Pas de revue de la `wrangler.toml` de production en environnement live (variables d'env non observables).
- Pas de revue de la configuration Stripe en live (Data Residency EU à confirmer manuellement).
- Pas de revue de la configuration Sentry en live (organisation EU à confirmer).
- Pas d'analyse comportementale des binaires R2 / images (avatars) — supposé out of scope S5 (cf. audit S6 pour les uploads frontend).
- Pas d'audit des backups Neon : la rétention par défaut Neon free tier est de 7 jours ; à valider qu'aucun backup ne dure plus longtemps en plan supérieur. Si la rétention dépasse 90 jours, la suppression "30-day" perd son sens (les données restent dans les backups).

### C. Références

- CNIL, Lignes Directrices 2020-091 (cookies & traceurs).
- EDPB Guidelines 04/2018 (consent), 05/2020 (consent updates).
- Schrems II — CJUE C-311/18 (transferts internationaux).
- Article 29 Working Party WP259 (transparency).

