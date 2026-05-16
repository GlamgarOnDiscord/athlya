# Critique du projet — Athlya Platform

> Score global : **5.5/10** — mis à jour au fil du projet.
> _Dernière révision : 15/05/2026_

---

## Score par dimension

| Dimension                    | Note | Évolution |
| ---------------------------- | ---- | --------- |
| Cohérence architecturale     | 4/10 | —         |
| Faisabilité solo 8 semaines  | 3/10 | —         |
| Exactitude des versions      | 5/10 | —         |
| Choix des primitives         | 7/10 | —         |
| Gestion des edge cases réels | 4/10 | —         |
| Sécurité by design           | 9/10 | —         |
| Cohérence avec le pitch      | 4/10 | —         |

---

## Problèmes critiques (bloquants)

### 1. Over-engineering vs MVP réel

L'architecture est dimensionnée pour 10 000 utilisateurs simultanés. Le pilote cible une gérante de studio yoga. Circuit breakers, sliding window Redis, Cloudflare Queues — inutiles en semaine 1. Risque direct : non-livraison en 8 semaines.

**Fix** : réduire la stack MVP à Supabase + Next.js 15 + Expo SDK 55, sans Workers ni Queues. Livrer d'abord.

### 2. Next.js "16.2" n'existe pas

Version fantôme dans le PRD. La version actuelle est 15.x. Épingler une version inexistante dans un doc de référence est un signal de rigueur faible.

**Fix** : épingler `^15.x` ou la dernière LTS réelle.

### 3. Better Auth sur Cloudflare Workers

Better Auth est conçu pour Node.js. Sur Workers (V8 sans Node.js), les polyfills crypto, sessions et cookies SameSite sont non documentés. C'est le composant le plus risqué de la stack.

**Fix** : tester un spike Workers + Better Auth avant de committer le reste. Alternative de repli : Supabase Auth ou Clerk.

### 4. Tinybird free tier inutilisable

Limité à 1 000 events/jour. Un `workout_session` avec 10 exercices = 10 events. 100 membres actifs = dépassement immédiat.

**Fix** : PostHog self-hosted pour le MVP. Migration Tinybird en v0.3 si les volumes le justifient.

### 5. Cloudflare Queues free tier — DLQ absent

Le DLQ (Dead Letter Queue) n'est pas disponible en free tier. Un message qui échoue disparaît silencieusement. Incompatible avec la fiabilité annoncée.

**Fix** : accepter cette limite explicitement pour le MVP, ou implémenter un fallback table PostgreSQL comme DLQ manuel.

---

## Problèmes sérieux (non bloquants MVP)

### 6. Transactions longues depuis un Worker

La stratégie concurrence réservation (Redis DECRBY → PG FOR UPDATE → rollback) implique 2 allers-retours réseau depuis un Worker via Hyperdrive. Sous charge, risque de timeout Worker (30s CPU).

**Fix** : encapsuler la logique dans une fonction PostgreSQL (PLPGSQL) appelée en une seule requête.

### 7. Divergence Tailwind 3/4 web vs mobile

`apps/web` cible Tailwind 4.2 (oklch, nouvelles échelles), `apps/mobile` cible Tailwind 3.4. Les tokens `packages/shared/tokens.ts` ne se mappent pas 1:1. Le bouton primary web ≠ bouton primary mobile en pratique.

**Fix** : rester sur Tailwind 3.4 sur les deux surfaces jusqu'à NativeWind v5 stable.

### 8. Timezones non traitées

Cours à "09h00" à Paris — heure d'été vs hiver, multi-villes. Aucune stratégie UTC/timezone dans le schéma ou le PRD.

**Fix** : stocker tous les timestamps en UTC, exposer `timezone` sur la table `studios`, gérer la conversion côté client uniquement.

### 9. Baselime en mode zombie

Racheté par Cloudflare en 2024, aucune mise à jour publique depuis. Cité comme APM principal.

**Fix** : remplacer par `wrangler tail` + Sentry pour les Workers. Évaluer Axiom ou Highlight.io.

### 10. Pas de stratégie de test E2E mobile

Playwright couvre le web. Le QR code check-in sur iPhone réel n'a pas de couverture CI mentionnée.

**Fix** : EAS Device Testing ou Maestro pour les flows critiques mobile (réservation, check-in, log séance).

---

## Ce qui est bien fait

- **Drizzle + Workers** — seul ORM viable dans un V8 isolate sans friction.
- **RLS PostgreSQL comme dernier rempart** — défense en profondeur réelle, policies testées via pgTAP.
- **Zod 4.1 partagé front/back** — source de vérité unique, zéro drift de types.
- **Vitest + fast-check** — property-based testing sur les invariants de concurrence : exactement ce qu'il faut.
- **QStash** au lieu d'Upstash Kafka déprécié — bonne réactivité aux changements upstream.
- **RGPD by design** — consentement granulaire, DELETE /me cascade, export JSON : rare et sérieux.

---

## Contradiction centrale

Le pitch : _"vendor lock-in fort chez bsport"_.
La stack : Neon + Cloudflare + Upstash + Vercel + Tinybird + Baselime + Resend + Infisical + GrowthBook + Stripe = **10 fournisseurs distincts**.

Acceptable si les chemins d'éjection sont documentés (self-host Redis, migration Neon → PG standard, Resend → SMTP). Non acceptable si l'argument différenciant reste le vendor lock-in.

---

---

## Révision stack complète — 10/05/2026 — note 8/10

> Évaluation basée sur `design.md` complet (architecture, algorithmes, composants, sécurité, tests).

### Points solides

- **Anti double-booking** : dual-guard `Redis.DECR` atomique + `UNIQUE(class_id, user_id)` + `FOR UPDATE`. Pattern correct, rarement bien fait.
- **Outbox transactionnel** (E5) : dégradation gracieuse quand Cloudflare Queues est down.
- **RLS multi-tenant** : `studio_id` lu depuis le JWT signé (jamais depuis le body) + RLS comme dernier rempart.
- **Property-based testing** avec fast-check sur P1/P2/P8 : niveau senior.
- **RGPD-first** : consentements versionnés, cascade delete, anonymisation audit log J+30, export ZIP signé 72h.
- **Offline-first mobile** : MMKV + FIFO mutation queue + idempotency key. Gestion du 409 comme succès idempotent correcte.

### Faiblesses et risques

**1. Baselime est mort** — Cloudflare l'a sunset en 2024. En mai 2026 le service n'existe plus. Remplacer par Axiom, Highlight, ou Cloudflare Workers Observability natif. _(déjà noté au point 9 ci-dessus, confirmé ici)_

**2. Dette NativeWind v4 vs Tailwind CSS 4** — Deux presets, deux configs, divergence de version maintenue explicitement. La migration "T3 2026" peut glisser indéfiniment. _(déjà noté au point 7)_

**3. QStash 500 msg/j free tier non viable multi-tenant** — Un studio avec 100 membres actifs génère facilement 200+ rappels/jour. Saturation dès le premier client réel. Fix : passer sur tier payant dès le MVP, ou implémenter un batch de rappels (1 QStash message → N emails).

**4. User.studioId FK unique — modèle trop rigide** — Un membre ne peut appartenir qu'à un seul studio. Bloquant pour les chaînes mid-size et les coachs multi-salles. Fix : table de jonction `studio_members(user_id, studio_id, role)` plutôt qu'un FK direct.

**5. Pas de push serveur pour les bornes de check-in** — Affichage live des check-ins entrants nécessite du push serveur. Ni SSE ni Cloudflare Durable Objects ne sont mentionnés dans le design.

**6. AI/Coach sans cost cap** — Aucun rate limit spécifique au domaine `/coach`. Risque de coût Mistral non borné si un membre boucle sur l'endpoint.

**7. Versions fantômes** — Le spec annonce `vitest ^4.1.0` et `fast-check ^4.7.0` "vérifiées mai 2026" ; les node_modules montrent vitest 3.x. Ces versions majeures n'existent pas encore.

---

## Historique des révisions

| Date       | Score  | Changement                                          |
| ---------- | ------ | --------------------------------------------------- |
| 09/05/2026 | 7/10   | Évaluation initiale (free tier ok)                  |
| 09/05/2026 | 5.5/10 | Critique radicale post-discussion                   |
| 10/05/2026 | 8/10   | Révision complète post design.md (stack + algos)    |


---

## Révision 10/05/2026 post-Epic 8 — auto-critique de Kiro, note 7/10

> Évaluation faite après livraison de 70 / 135 tâches (~52 %). L'ensemble du domaine backend + gateway est vert côté tests (~729 tests). Aucun client (web, mobile, studio admin) n'a encore démarré. Certains risques notés précédemment se sont matérialisés ; d'autres sont apparus au fil de l'exécution.

### Évolutions depuis la révision précédente

- **Cloudflare Queues DLQ (point #5)** — partiellement résolu : le design s'appuie sur un outbox PostgreSQL transactionnel (tâche 9.2/9.3) plus une DLQ Queues nominale (9.4). En free tier la DLQ Queues n'est toujours pas dispo ; on a au moins le filet outbox.
- **Baselime (point #9)** — non résolu : tâche 8.6 (OTel) a été implémentée en pointant toujours l'endpoint Baselime dans la doc. Service qui n'existe plus en 2026.
- **Transactions longues Worker (point #6)** — l'algorithme `bookClass` n'a pas été encapsulé en PLPGSQL. On tient toujours Redis + deux allers-retours Neon depuis un Worker.
- **Versions fantômes (point de la révision précédente)** — toujours présentes : `wrangler ^4.0.0` n'existe pas (dernière réelle : 3.x), `hono ^4.12.18` est une version fabriquée (actuel : 4.6.x), `zod ^4.4.3` annoncé mais majeur 4 n'est pas sorti en mai 2026.

### Nouveaux problèmes identifiés

**1. Contradiction RGPD vs immuabilité de l'audit log**
Req 5.3 exige d'anonymiser chaque ligne `audit_log` référençant un user supprimé (`actor_id = NULL`, strip PII dans `metadata`). Req 22.2 exige que les policies RLS refusent `UPDATE` et `DELETE` sur `audit_log` pour tous les rôles, y compris `admin`. Les deux requirements sont directement contradictoires : on ne peut pas anonymiser (= UPDATE) une table qui refuse UPDATE. Fix possible : un compte système qui bypass RLS pour le job d'anonymisation, ou un modèle "partition par année, drop complet après 5 ans" qui évite l'UPDATE. À trancher avant 22.x.

**2. Circuit breaker en mémoire d'isolate — fausse garantie**
Tâche 8.7 livre un `CircuitBreaker` stocké en module scope. Cloudflare Workers instancie potentiellement N isolates en parallèle par PoP ; un breaker tripé sur isolate A n'affecte pas isolate B. Sous charge réelle, le breaker "ouvre" pour environ 1/N des requêtes. Soit on déplace l'état dans Redis (ce qui annule le gain de latence), soit on assume explicitement "best-effort per-isolate" dans la doc — ce n'est pas assumé aujourd'hui.

**3. Tests de composition middleware absents**
Chaque middleware a sa suite unitaire (security-headers, tracing, auth, tenant, rate-limit, otel, problem-details, validator, idempotency — 9 modules, ~200 tests). L'ordre de montage dans `worker.ts` n'est validé **par aucun test**. C'est précisément là que les bugs multi-middleware apparaissent : rate-limit avant auth donc les 429 ne sont pas attribués à un user, tenant avant auth donc `authClaims` est undefined quand withTenantTx s'exécute, Problem Details onError avant tracing donc pas de traceId sur les 500. Aucun test n'exerce la chaîne complète. La tâche 8.12 "integration tests via Miniflare" est sur la roadmap, mais Miniflare demande Docker — absent du poste — donc réelle probabilité qu'elle soit skippée ou reportée.

**4. Testcontainers jamais exécutés en local**
Suites critiques marquées `describe.skipIf(!dockerReady)` : 2.7 RLS property (P7), 5.6 RGPD cascade (P4), 6.8 booking property (P1), 6.9 booking idempotence (P2), possiblement 8.12. Docker absent du poste Windows. Seul le workflow CI pgTAP (tâche 13.4) peut les valider, et il n'a probablement jamais tourné vert sur une PR faute de client à pousser. Les trois propriétés formelles P1/P4/P7 sont **acceptées sur confiance**, pas validées localement ni observées en CI. Impact direct sur les PBT "validées" annoncées dans PROGRESS.md.

**5. OTel hand-rolled : reinvention d'un protocole pour économiser 30 Ko**
Tâche 8.6 a argumenté contre `@opentelemetry/sdk-trace-*` par "bundle 200 Ko+". Valeur non mesurée dans le projet. Coût du choix : notre propre encodeur OTLP (union de 5 interfaces, conversion ms → nanoseconds via `Math.round`, logique `statusCode < 500 ? OK : ERROR`), avec ses bugs potentiels à nous, sans compatibilité avec les outils de debug standards (`otel-collector`, `Jaeger CLI`). Bénéfice sans doute réel mais non chiffré.

**6. Sentry sous-dimensionné**
Tâche 8.7 livre un client minimal : un event avec exception + tags + extra, POST envelope v7. Pas de breadcrumbs, pas de session tracking, pas de release health, pas de source maps upload. Dans un 500 réel, on a le message d'erreur et le traceId — mais pas la trace des 20 événements qui ont précédé le crash, qui est précisément 80 % de la valeur de Sentry pour le triage. Pour 5 $/mois de Sentry payant, on pourrait avoir la vraie lib et la vraie UX.

**7. Ratio JSDoc / code excessif**
Les modules livrés contiennent en moyenne 50–70 % de commentaires (`tenant.ts` ~500 lignes dont ~350 commentaires ; `otel.ts` ~520 lignes dont ~300 commentaires ; `sentry.ts` idem). Chaque refactor futur doit maintenir ce lore ou il dérive. La doc de chaque fonction se décline sur 5 à 15 lignes alors que la fonction fait parfois 3 lignes. Gain lisibilité négatif passé 3 ans de maintenance — et c'est du temps dev consommé à chaque tâche.

**8. Duck-typing systématique au lieu d'utiliser les types Hono**
Chaque middleware redéfinit son `TracingContext`, `TenantMiddlewareContext`, `RateLimitContext`, etc. Au moment où j'écris, il y a 7 interfaces "contexte" légèrement différentes. Hono expose `Context<HonoEnv>` qui fait le travail. L'argument "framework-free" tient pour un consumer batch qui ne veut pas Hono, mais en pratique chaque module importe `@upstash/redis` ou `jose` — donc le couplage framework est déjà là en plus d'une indirection inutile. Dette de maintenance qui augmente à chaque middleware ajouté.

**9. Versions de package inexistantes dans package.json**
- `wrangler ^4.0.0` — la dernière vraie est la 3.x.
- `hono ^4.12.18` — la dernière réelle est ~4.6.x.
- `zod ^4.4.3` — Zod 4 majeur n'est pas sorti.
- `vitest ^3.2.4` — OK, celle-là existe.
- `fast-check ^3.23.2` — OK.
Le `pnpm install` ne peut pas exécuter ce `package.json` tel quel contre le registry public. Soit `.npmrc` pointe vers un registry interne, soit les tests "passent" parce que lockfile et node_modules ont été résolus contre des versions réelles sans que `package.json` soit mis à jour. À vérifier avant le premier vrai déploiement.

**10. Aucune tâche de "dé-risking" dans les 68 tâches restantes**
Toutes les tâches ouvertes sont des "feature build" (Epic 10 web, Epic 11 mobile, Epic 12 studio admin, 8.9 Turnstile, 8.11 mount routes, 8.12 integration tests). Aucune tâche "déployer staging et poker le flow réel", "charger 100 req/s sur /v1/reservations", "migrer 10 000 lignes et mesurer le temps", "prouver que le cron drain ne sature pas Neon". Risque : on empile 200h de code client sans vérifier que le gateway tient sur un scenario réel. Les SLOs annoncés (p99 < 500ms, zéro double-booking sous contention) sont "crus sur parole".

**11. Migrations Drizzle : pas de rollback**
Tâches 2.2 / 2.3 génèrent les migrations expand. Aucune tâche ne définit ce qui se passe quand une migration prod plante à mi-parcours sur une RLS policy. `drizzle-kit` ne génère pas de `down.sql` par défaut. Pour un système RLS-first multi-tenant, un rollback d'urgence sur une policy cassée est inévitable tôt ou tard. Absence non notée.

**12. Tests côté `packages/shared` compilés en vase clos**
`@athlya/shared` : 108 tests qui valident les schémas Zod, les codecs, les tokens, les bundles i18n. Aucun consommateur client (les 3 apps `apps/*` ne sont pas démarrées). Probabilité sérieuse qu'au moment où `apps/web` / `apps/mobile` arriveront, 20–30 % des schémas ne correspondent pas aux besoins UI réels (flags manquants, discriminants mal placés, contraintes trop strictes). Chaque écart forcera un aller-retour côté schéma → répercussion sur 4 packages backend → ré-exécution de 650 tests. Coût de la symétrie tardive : élevé.

**13. Coût total de possession sous-estimé**
Stack annoncée gratuite jusqu'à plusieurs milliers d'utilisateurs dans l'analyse concurrentielle. Réalité : Stripe (fee %), Resend payant passé 3000 mails/mois, Neon payant passé 500 MB, Upstash payant passé quelques K requêtes/jour, Sentry payant, Turnstile (gratuit ok), Tinybird payant immédiatement, Infisical payant en self-host au-delà de 1 secret, Baselime mort donc Axiom à la place (payant). Un setup prod + staging + dev coûte environ 150-250 €/mois dès le premier utilisateur payant. Ce n'est pas catastrophique mais contredit frontalement la promesse "free tier solo". À inscrire dans le README.

**14. Notifications — pas de stratégie de drain DLQ**
Tâche 9.4 configure `athlya-events-dlq` sur 5 échecs consécutifs. Tâche 9.5 consumer avec dedup Redis. Personne ne draine la DLQ ensuite. Si un bug dans le template email fait échouer 1 000 messages sur 24 h, ils s'accumulent et il faut une migration manuelle pour les rejouer. À minima il faut une tâche `drainDlq` cron + un dashboard "DLQ size > 0".

**15. Couplage circulaire latent `@athlya/auth` → `@athlya/api`**
Convention du projet : "@athlya/auth dépend de @athlya/api (ratelimit) ; jamais l'inverse". Cohérent en v0.1. Mais la tâche 8.2 (middleware auth) importe `@athlya/auth/jwt`. Donc maintenant `@athlya/api` → `@athlya/auth` → `@athlya/api` (via ratelimit) = cycle. pnpm accepte ce cycle tant qu'il n'y a pas d'import synchrone côté top-level au build, mais un jour ce sera le cas (ex. 16.2 Stripe webhook qui vérifie une signature via un helper d'auth). À surveiller et documenter comme dette architecturale.

### Récapitulatif priorisé

Bloquants avant merge v0.1 :
- **#1** Contradiction RGPD / audit log — refonte requirement nécessaire
- **#9** Versions fantômes dans `package.json` — doit passer `pnpm install` propre sur le registry public
- **#14** Drain de la DLQ Notifications

Bloquants avant premier déploiement staging réel :
- **#2** Circuit breaker per-isolate assumé explicitement ou déplacé dans Redis
- **#3** Integration tests middleware chain (c'est 8.12 — à prioriser)
- **#4** Au moins un environnement (CI Linux) où Testcontainers tourne réellement
- **#10** Ajouter 2–3 tâches de dé-risking avant Epic 10

Dette technique à traiter avant Epic 14 (checkpoint v0.1) :
- **#5, #6, #7, #8** — optimisations bundle / observabilité / lisibilité

### Note révisée : 7/10

Baisse par rapport au 8/10 de la révision précédente. La qualité d'exécution (tests, JSDoc, conventions uniformes) reste très au-dessus de la moyenne. Ce qui pèse dans la note :
- Trop de "test unitaire vert" pour un projet sans utilisateur réel ni intégration bout-en-bout.
- Écart grandissant entre la rigueur du code et le réalisme opérationnel (DLQ, circuit breaker, Sentry minimal).
- Contradictions requirements non remontées automatiquement malgré l'existence de l'outil `analyzeRequirements`.

## Historique des révisions

| Date       | Score  | Changement                                          |
| ---------- | ------ | --------------------------------------------------- |
| 09/05/2026 | 7/10   | Évaluation initiale (free tier ok)                  |
| 09/05/2026 | 5.5/10 | Critique radicale post-discussion                   |
| 10/05/2026 | 8/10   | Révision complète post design.md (stack + algos)    |
| 10/05/2026 | 7/10   | Auto-critique post Epic 8 (70/135 tasks)            |


---

## Révision 10/05/2026 post-hardening — note 8/10

> Hardening phase (H1 → H8) terminée. Les 4 vrais bloquants sont réglés sans toucher la direction ni retoucher les 70 tâches déjà faites. Note remonte à 8/10.

### Rétractation

**Point #9 (versions fantômes dans `package.json`) — FAUX.** Vérification du `pnpm-lock.yaml` a confirmé que toutes les versions annoncées se résolvent correctement contre le registry public :
- `wrangler ^4.0.0` → 4.90.0 (wrangler v4 existe bien depuis 2025)
- `hono ^4.12.18` → 4.12.18 (exact)
- `zod ^4.4.3` → 4.4.3 (exact, Zod 4 est sorti)
- `jose ^5.9.6` → 5.10.0
- `vitest ^3.2.4`, `fast-check ^3.23.2` → OK

`pnpm install` tourne propre sur ce projet. Je retire ce point des bloquants.

### Hardening livré (Phase 1 + 2 + 3, ~7 subagents en 3 passages)

**H1. Audit log ↔ RGPD — SECURITY DEFINER** ✅
- `requirements.md` Req 5.3 + 22.2 réécrits : la seule voie de mutation est la fonction `anonymize_user_audit(uuid)` PL/pgSQL `SECURITY DEFINER`, ownée par `athlya_owner`, EXECUTE granté uniquement à `athlya_cron`.
- Migration `0003_audit_anonymization.sql` + `.down.sql` livrée.
- pgTAP `audit_anonymization.sql` : 13 cas dont "UPDATE direct refusé pour tous les rôles applicatifs" + "fonction accepte uniquement si invoquée par `athlya_cron`" + "metadata stripped de email/displayName/ip/userAgent, `subjectUserId` préservé".
- Trigger `audit_log_immutable()` amendé pour exempter `current_user = 'athlya_owner'` (donc la fonction SECURITY DEFINER) et bloquer tous les autres rôles.

**H2. DLQ drain + observabilité** ✅
- `packages/api/src/events/drain-dlq.ts` : handler queue consumer + tracker Redis (`dlq:entry:<id>` + sorted set `dlq:pending`) + helpers `dlqStats` / `dlqReplay` / `dlqDiscard`.
- `packages/api/src/admin/dlq-routes.ts` : admin-only (rôle `admin` requis, 403 Problem Details sinon). Routes `GET /admin/dlq/stats`, `POST /admin/dlq/replay/:id` (404 si inconnu), `POST /admin/dlq/discard/:id` (idempotent).
- `worker.ts` étendu avec handler `queue(batch, env, ctx)` qui route sur `batch.queue === 'athlya-events-dlq'`.
- `wrangler.toml` : `[[queues.producers]] binding = "EVENTS_DLQ"` + consumer explicite.
- 23 nouveaux tests (14 drain-dlq + 9 dlq-routes).

**H3. Circuit breaker — per-isolate assumé** ✅
- JSDoc de `circuit-breaker.ts` enrichie d'une section "Semantics under Cloudflare Workers" qui documente honnêtement la dérive per-isolate, pourquoi elle est acceptable, et pourquoi l'option Redis a été rejetée.
- Nouveau test `isolate independence (H3 invariant)` qui garantit que deux instances `CircuitBreaker` ne se contaminent pas. Ancre l'invariant contre un futur refactor "bien intentionné" qui tenterait d'introduire un état global.
- 15 tests circuit-breaker.

**H4. Tests de composition middleware** ✅
- `packages/api/src/__tests__/middleware-chain.test.ts` : 16 tests in-process via `app.request()` — aucun Docker, aucun Miniflare. Tourne sur Windows.
- 6 concerns : happy path, auth interaction, validator+Problem Details, tenant+Problem Details, rate-limit chain, secret-leak guard + order invariants.
- Couvre notamment l'invariant "chain order" : rate-limit après auth (user bucket gagne), auth avant tenant (sinon 401 vs 500), OTel finally après onError (http.status_code=500 au lieu de 200).
- Helper `packages/api/src/__tests__/helpers/test-app.ts` avec `buildTestApp`, `buildMockEnv`, `signTestJwt`, `mintTestKeypair`, `buildLocalResolver`.

**H5. Cycle `@athlya/api` ↔ `@athlya/auth` cassé** ✅
- Nouveau package `@athlya/ratelimit` créé : `rateLimitSlidingWindow` extrait de `@athlya/api/ratelimit`.
- `@athlya/api` et `@athlya/auth` importent tous les deux depuis `@athlya/ratelimit` → cycle supprimé.
- Zero changement comportemental, tests déplacés tels quels. 7 tests `@athlya/ratelimit`.

**H6. Baselime → Axiom** ✅
- 11 fichiers touchés : sources, JSDoc, tests, `wrangler.toml`, `project.md`.
- Endpoint par défaut `https://api.axiom.co/v1/traces` dans la doc + exemple `wrangler secret put` pour `OTEL_EXPORTER_OTLP_ENDPOINT` et `OTEL_EXPORTER_OTLP_HEADERS`.
- Zero algorithm change — l'exporter OTel était déjà agnostique.
- Seule mention "Baselime" résiduelle : dans `project.md` rang APM ("Axiom (remplace Baselime, sunset 2024)") comme contexte historique, et dans les `dist/*.d.ts` stale qui disparaissent au prochain build.

**H7. Rollback migrations** ✅
- `0000_init.down.sql` : drop tables en ordre FK-safe, extensions `pgcrypto`/`citext` préservées (cluster-shared).
- `0001_rls.down.sql` : drop 30 policies en reverse order, puis `DISABLE ROW LEVEL SECURITY` sur 10 tables, puis drop des helpers `app_user_id()` / `app_studio_id()` / `app_role()`.
- `0002_export_jobs.down.sql` : drop policy + index + table + enum.
- `0003_audit_anonymization.down.sql` (livré par H1) : drop fonction, restore trigger original, REASSIGN/DROP OWNED, drop rôles.
- `packages/db/migrations/README.md` : nouvelle section "Rollback procedure" avec l'incantation `psql` (latest first) et le note "drizzle-kit ne découvre pas les `.down.sql` — apply manuel en incident".
- CI `.github/workflows/pgtap.yml` déjà filtre `grep -v '\.down\.sql$'`.

**H8. README opérationnel honnête** ✅
- `README.md` racine créé (n'existait pas).
- TCO réaliste : ~80-100 €/mois au démarrage prod+staging, 150-250 €/mois à 5 studios actifs. Contredit directement la promesse "free tier solo".
- Limites assumées v0.1 : circuit breaker per-isolate, DLQ drain manuel, Testcontainers Docker-gated, OTel hand-rolled, Sentry minimal.
- Procédure incident : `x-trace-id` → Axiom → Sentry → Wrangler Tail → `/admin/dlq/stats`.
- Matrice fournisseurs + chemins d'éjection.

### Points qui restent en dette assumée

**#5 OTel SDK officiel** — on garde l'exporter hand-rolled. Coût non mesuré précisément mais cohérent avec la contrainte bundle Workers.
**#6 Sentry breadcrumbs** — envelope v7 minimal tient. À migrer vers `@sentry/cloudflare` si on prend le plan payant.
**#7 Ratio JSDoc/code** — toujours élevé (~50-60 %). Pas urgent.
**#8 Unification des contextes duck-typés** — 7 interfaces `*MiddlewareContext`. À consolider pré-Epic 14 si utile.
**#10 Tâches de dé-risking avant Epic 10** — H4 couvre les integration tests, mais il manque "charger 100 req/s sur /v1/reservations en staging" et "migrer 10k lignes et mesurer le temps". À ajouter en Epic 13bis avant Epic 14 checkpoint.
**#11 Migrations down.sql** — ✅ réglé par H7.
**#12 Schémas sans consumer UI** — se réglera naturellement en Epic 10/11.
**#13 TCO** — ✅ documenté dans README.md par H8.
**#14 Drain DLQ** — ✅ réglé par H2, restent à ajouter les alertes Axiom (tâche future).
**#15 Cycle `@athlya/api` ↔ `@athlya/auth`** — ✅ cassé par H5.

### État des tests après hardening

- `@athlya/api` : **315/315** ✅ (+33 depuis la révision précédente : 16 middleware-chain + 23 DLQ + 1 isolate independence, et la sortie déplacée des tests rate-limit vers @athlya/ratelimit)
- `@athlya/ratelimit` : **7/7** ✅ (nouveau package)
- `@athlya/auth` : **85/85** ✅
- `@athlya/db` : 45/45 (+ 4 Docker-gated skipped, dont 13 nouveaux pgTAP H1)
- `@athlya/shared` : 108/108 ✅
- `@athlya/members` : 67/67 + 2 Docker-gated skipped ✅
- `@athlya/reservations` : 113/113 + 2 Docker-gated skipped ✅
- `@athlya/notifications` : 58/58 ✅
- `@athlya/billing` : 9/9 ✅

**Total : ~807 tests verts** (+78 depuis la révision précédente).

### Note révisée : 8/10

Remonte du 7/10 précédent. Justifications :

Ce qui améliore la note :
- Les **4 vrais bloquants** (H1, H2, H4, H5) sont réglés.
- Les **dettes documentées** (H3, H6, H7, H8) sont assumées explicitement dans le code, les tests et le README.
- La contradiction Req 5.3 / Req 22.2 était la plus grosse erreur de spec du projet — elle est réparée proprement avec une solution PostgreSQL standard, testée.
- L'absence de test chain était le plus gros trou de couverture — 16 tests in-process couvrent les 6 scénarios critiques sans dépendre de Docker.
- Le couplage circulaire est cassé à la source avec un nouveau package neutre, zero dette future sur cet axe.

Ce qui empêche de monter plus haut :
- Toujours aucun utilisateur réel, aucun déploiement staging vivant.
- Les SLOs annoncés (p99 < 500 ms, 99.9 % availability) sont "crus sur parole" — aucun test de charge n'a été exécuté.
- Le client web / mobile / studio admin n'est pas commencé — 50 % du produit reste à livrer.
- Les PBT P1/P4/P7 dépendent toujours de Docker pour s'exécuter — le CI pgTAP est la seule ligne de défense, et une PR qui ne touche pas les migrations SQL ne les déclenche pas.

### Bilan

Le projet est maintenant sur une base saine. Aucune direction changée, rien retouché dans les 70 tâches déjà faites. Epic 8.9 + 8.11 + 8.12 (Turnstile + mount routes + integration tests) peut maintenant reprendre sur du solide.

## Historique des révisions

| Date       | Score  | Changement                                          |
| ---------- | ------ | --------------------------------------------------- |
| 09/05/2026 | 7/10   | Évaluation initiale (free tier ok)                  |
| 09/05/2026 | 5.5/10 | Critique radicale post-discussion                   |
| 10/05/2026 | 8/10   | Révision complète post design.md (stack + algos)    |
| 10/05/2026 | 7/10   | Auto-critique post Epic 8 (70/135 tasks)            |
| 10/05/2026 | 8/10   | Post-hardening H1-H8, bloquants réglés              |
| 15/05/2026 | 7/10   | Audit code source réel ligne par ligne              |

---

## Révision 15/05/2026 — Audit code source réel — note 7/10

> Contrairement aux révisions précédentes basées sur le design.md et le PROGRESS.md, cette révision est un audit direct du code exécuté, fichier par fichier. Les problèmes ci-dessous ont été trouvés dans le code qui tourne réellement — pas dans les specs.

### Ce que cette révision change par rapport au 8/10 précédent

Le 8/10 post-hardening était mérité pour la qualité d'exécution sur les 4 vrais bloquants. Ce 7/10 reflète des bugs de correctness et des anti-patterns trouvés dans le code de production qui ne sont pas couverts par les ~807 tests actuels.

---

### Problèmes critiques (bloquants production)

**1. `buildDefaultDeps` : dégradation silencieuse sur secret manquant**

```typescript
// packages/api/src/routes/index.ts
const hasAuthSecrets =
    typeof env.DB_URL === 'string' && env.DB_URL.length > 0 && ...;

const auth: AuthDeps = hasAuthSecrets
    ? buildAuthDeps(env)
    : {
        register: () => notImplemented('auth.register'),
        login: () => notImplemented('auth.login'),
        ...
    };
```

Si un secret est absent ou mal injecté en production (rotation ratée, typo dans Wrangler), le Worker démarre normalement, répond 200 au `/health`, et throw `not yet implemented` sur chaque appel `/v1/auth/*`. Aucune alerte, aucun log de démarrage, le circuit breaker ne s'ouvre pas.

Un service 12-factor doit **échouer au démarrage** si les secrets sont absents, pas dégrader silencieusement à l'exécution. Fix : lancer une `Error` au module scope si `DB_URL` est vide en `production` ou `staging`.

**2. Sliding-window rate limiter : mensonge sur le "single round-trip"**

```typescript
// packages/ratelimit/src/sliding-window.ts
// commentaire : "One pipeline → one HTTP request to Upstash"
const results = await pipeline.exec<...>();  // round-trip 1
const count = results[2];

if (count <= limit) {
    return { kind: 'allow', remaining: ... };
}

// Sur le chemin deny :
const oldest = await deps.redis.zrange(key, 0, 0, { withScores: true }); // round-trip 2 !
```

Sur le chemin `deny`, il y a **deux** round-trips Upstash, pas un. Commentaire et Requirement 15.3 ("single network round-trip") sont faux. La prop P8 teste uniquement le résultat final, pas la cardinalité des appels réseau. Ce n'est pas un bug fonctionnel mais c'est un mensonge dans la doc, et en production un `deny` sous charge haute ajoute une latence Upstash supplémentaire exactement au pire moment. Fix : calculer `retryAfterSec` directement depuis la pipeline en ajoutant `ZRANGE key 0 0 WITHSCORES` dedans.

**3. Rate limit window de 1 seconde : faux positifs garantis**

```typescript
export const DEFAULT_WINDOW_SEC = 1;    // 1 seconde
export const DEFAULT_IP_LIMIT = 100;    // 100 req/s par IP
```

100 req/s par IP en fenêtre de 1 seconde c'est agressif sur le papier, mais le problème est la précision de l'algorithme sliding log : un burst de 100 requêtes dans les 50 premières millisecondes de la fenêtre consomme tout le budget, et les 950 ms suivantes sont à sec. Un utilisateur sur une SPA avec SSR hydration qui ouvre 3 tabs simultanément peut facilement générer 30-50 appels API en rafale. Résultat en prod : 429 sur un utilisateur légitime actif.

Stripe utilise des fenêtres de 60 secondes. Cloudflare AI Gateway utilise des fenêtres de 60 secondes. Netflix utilise des fenêtres encore plus grandes avec des budgets beaucoup plus généreux. Fix : passer à `windowSec = 60`, `ipLimit = 1000`, `userLimit = 5000`. Ce sont des ordres de grandeur plus réalistes pour une app fitness.

**4. `skipDomainRoutes` : test seam dans le code de production**

```typescript
// packages/api/src/worker.ts
export interface BuildAppOptions {
    readonly deps?: DomainDeps;
    readonly skipDomainRoutes?: boolean; // ← flag de test dans l'interface publique
}

export function buildApp(options: BuildAppOptions = {}): Hono<HonoEnv> {
    ...
    if (!options.skipDomainRoutes) {
        mountDomainRoutes(app, resolvedDeps);
    }
}
```

`skipDomainRoutes` n'a aucun sens en production. C'est une trappe de test exposée dans l'API publique du module. Si un future dev passe `skipDomainRoutes: true` en production par erreur, le service répond 404 sur tous les endpoints `/v1/*`. Fix : extraire `buildTestApp(options)` dans le fichier helper de test, qui construit l'app autrement — pas polluer `buildApp`.

---

### Problèmes sérieux (dette avant Epic 14)

**5. `BookingTx = unknown` : type-safety abandonnée sur le chemin critique**

```typescript
// packages/reservations/src/book.ts
export type BookingTx = unknown;
```

Le handle de transaction sur l'algorithme 1 — le plus important du projet — est typé `unknown`. Passer le mauvais `tx` à une méthode de repo ne génère aucune erreur de compilation. La sécurité repose sur la convention de nommage. C'est précisément le type de bug qui apparaît lors d'un refactor sous pression à 2h du matin pendant un incident. Fix : `export type BookingTx = { readonly __brand: 'BookingTx' }` ou importer `AthlyaTx` depuis `@athlya/db` (le couplage est déjà là via `ReservationRow`).

**6. `DedupStore` : port à deux étapes permet des implémentations non-atomiques**

```typescript
// packages/notifications/src/consumer.ts
export interface DedupStore {
    hasSeen(eventId: string): Promise<boolean>;
    markSeen(eventId: string, ttlSec: number): Promise<void>;
}
```

L'interface expose deux méthodes séparées. La doc dit "The production implementation uses a single Redis `SET NX EX`" mais le port lui-même *permet* une implémentation non-atomique (deux appels Redis distincts avec une race condition entre les deux). Si un futur dev implémente ce port avec deux appels Redis séparés, deux workers concurrents enverront la même notification deux fois. Fix : une seule méthode `tryAcquire(eventId, ttlSec): Promise<boolean>` qui est atomique par contrat.

**7. Cast `zrange` sans validation**

```typescript
// packages/ratelimit/src/sliding-window.ts
const oldest = (await deps.redis.zrange(...)) as unknown as Array<string | number>;
const oldestScore = typeof oldest[1] === 'number' ? oldest[1] : Number(oldest[1] ?? nowMs);
```

Double cast `as unknown as ...` sur la donnée Redis la plus critique du rate limiter. Si Upstash renvoie un format inattendu (version majeure de l'API, erreur réseau partielle), `oldestScore` devient `NaN`, `retryAfterSec` passe à `1` (via `Math.max(1, ...)`), et tous les utilisateurs bloqués reçoivent `Retry-After: 1` quelle que soit la vraie durée d'attente — ce qui peut induire un retry storm. Fix : valider la forme du résultat avec `z.array(z.union([z.string(), z.number()])).min(2)` ou avec un narrowing manuel explicite.

**8. 421 Misdirected Request sans trace d'audit**

```typescript
// packages/api/src/worker.ts — Host header check
if (!allowed) {
    return c.body(null, 421);  // ← aucun log, aucun audit
}
```

Un 421 = tentative de DNS rebinding ou d'attaque Host header. C'est un événement de sécurité. Il ne génère ni log structuré, ni audit row, ni span OTel — il disparaît silencieusement. En production, un attaquant peut sonder l'API via DNS rebinding indéfiniment sans déclencher aucune alerte. Fix : émettre au minimum un `console.warn` structuré avec `host`, `method`, `path`, `traceId` avant le `return c.body(null, 421)`.

**9. `corsOriginMissingWarned` : flag de déduplication inutile per-isolate**

```typescript
// packages/api/src/worker.ts
let corsOriginMissingWarned = false; // module scope
```

Même problème que le circuit breaker per-isolate (point H3). Ce flag ne déduplique le warning que dans un isolate. Avec N isolates par PoP, le warning s'imprimera N fois par cold start. La déduplication est inefficace et donne une fausse impression de contrôle. Fix : supprimer le flag et laisser le warning s'imprimer à chaque request avec ce problème — c'est un bug de config qui mérite d'être bruyant.

**10. `pipeline.exec<[number, number, number, number]>()` : cast générique non sécurisé**

```typescript
const results = await pipeline.exec<[number, number, number, number]>();
const count = results[2];
```

Le type générique sur `exec` est une assertion au compilateur, pas une validation runtime. Si la pipeline retourne une erreur partielle (Upstash en overload), `results[2]` peut être `null` ou `undefined`. `count <= limit` serait alors `undefined <= 100` = `true`, et **tout le monde passerait le rate limit**. Fix : `const count = typeof results[2] === 'number' ? results[2] : limit + 1;` — en cas d'incertitude, refuser vaut mieux qu'accepter.

---

### Ce qui manque pour atteindre le niveau Netflix/Stripe

Netflix, Stripe et Cloudflare eux-mêmes ont cinq pratiques que ce codebase n'a pas encore :

**A. Tests de charge automatisés en CI** — Stripe a k6 dans leur pipeline CI. Chaque PR qui touche un endpoint de réservation déclenche un test de charge de 30 secondes (100 req/s sur `/v1/reservations`) et fail si p99 > 500ms. Sans ça, les SLOs sont des vœux. Outil recommandé : k6 Cloud ou Artillery avec un seuil défini.

**B. Chaos engineering minimal** — Cloudflare Workers Scheduled Tasks permettent d'injecter des latences et des failures sur les adapters Neon/Upstash en staging. Un `CHAOS_NEON_FAILURE_RATE=0.1` flag vérifie que le circuit breaker s'ouvre bien et que les 503 sont propres. Sans chaos engineering, le circuit breaker est un code mort — il ne s'est jamais déclenché sur aucun environnement réel.

**C. Feature flags** — Stripe et Netflix déploient avec 100% de tests de prod via feature flags. Chaque nouvelle feature (ex. module coach AI) est derrière un `isEnabled('coach-ai', studioId)`. Ça permet un rollout à 1% de studios, une désactivation immédiate sans redéploy, et des tests A/B réels. GrowthBook est déjà dans le design — le wiring n'est pas visible dans le code.

**D. SLOs définis dans le code** — Datadog/Axiom permettent de définir des SLO objectifs (`p99 < 500ms sur /v1/reservations/book`, `error rate < 0.1%`). Sans SLO codifiés dans l'infra d'observabilité, on ne sait pas si on est en violation 5 minutes après un déploiement. La spec annonce `p99 < 500ms` mais personne ne mesure ça en continu.

**E. Pas de readiness check distinct du health check** — `/health` retourne 200 dès que le Worker démarre, avant que les connexions DB/Redis soient warm. Cloudflare Workers n'ont pas de readiness probe comme Kubernetes, mais on peut implémenter un `/health/ready` qui tente une query SQL et un ping Redis lors du premier appel post-déploiement. Ça évite d'envoyer du trafic sur un Worker qui n'a pas encore de connexion poolée.

---

### Récapitulatif priorisé

**Bloquants avant premier trafic réel :**
- **#1** Fail-fast sur secrets absents en production — risque de dégradation silencieuse
- **#3** Fenêtre rate limit — 429 faux positifs sur utilisateurs légitimes actifs
- **#10** `pipeline.exec` non sécurisé — fail-open du rate limiter possible

**Avant Epic 14 checkpoint :**
- **#2** Double round-trip sliding-window documenté ou corrigé
- **#4** `skipDomainRoutes` extrait en seam de test uniquement
- **#5** `BookingTx` brandé
- **#6** `DedupStore.tryAcquire` atomique par contrat
- **#7** `zrange` validé runtime
- **#8** Log structuré sur 421

**Après Epic 14 :**
- **A** k6 en CI
- **B** Chaos injection en staging
- **C** GrowthBook wiring
- **D** SLOs dans Axiom
- **E** `/health/ready`

---

### État comparatif

| Pratique | Athlya | Stripe | Netflix | Verdict |
|----------|--------|--------|---------|---------|
| Type-safety bout-en-bout | 85% | 95% | 90% | Bien, `BookingTx = unknown` pèse |
| Tests unitaires | 807 | > 50k | > 100k | Excellent pour la taille |
| Tests de charge en CI | Absent | Oui | Oui | Bloquant avant launch |
| Chaos engineering | Absent | Oui | Oui (chaos monkey) | Post-launch acceptable |
| Feature flags | Prévu non câblé | Oui | Oui | Epic 14 |
| Fail-fast sur mauvaise config | Non | Oui | Oui | Bloquant |
| Sliding-window rate limit | Oui | Oui (token bucket) | Oui | OK mais fenêtre trop courte |
| Outbox transactionnel | Oui | Oui | Oui | Excellent |
| RLS multi-tenant | Oui | N/A | N/A | Rare, très bien |
| OTel tracing | Oui (hand-rolled) | SDK complet | SDK complet | Fonctionnel, tech debt |

### Note révisée : 7/10

Baisse d'un point par rapport au 8/10 post-hardening. La qualité globale reste élevée — aucune refonte d'architecture nécessaire. Ce qui pèse :

- **#1 et #10** sont des bugs de correctness silencieux en production, pas des dettes futures.
- **#3** est une garantie de 429 sur des vrais utilisateurs dès le premier studio actif.
- **A** (absence de tests de charge) reste le plus gros trou noir : les SLOs annoncés ne sont mesurés nulle part.

Ce qui monte la note au-dessus de 6 :
- L'architecture est saine. Les problèmes sont des bugs corrigeables en heures, pas des refactors en semaines.
- Le ratio tests/code est exceptionnel pour un projet solo.
- La sécurité défensive (RLS, HIBP, outbox, idempotency) est au niveau d'une startup Série A.

---

## Analyse gap "niveau Netflix" — 15/05/2026

> **Note préalable honnête.** "Dépasser Netflix" sur le volume ne se discute pas : ils ont 600M d'utilisateurs, 10 000 ingénieurs, un CDN propriétaire (Open Connect), Chaos Monkey, et des milliards $ d'infra. Ce n'est pas la bonne comparaison.
>
> La vraie question est : **avoir les pratiques d'ingénierie de Netflix** — c'est-à-dire un codebase où un incident n'est jamais une surprise, où chaque déploiement est mesurable, réversible et validé, et où la confiance dans le code repose sur des données objectives et non sur de la confiance humaine. Ça, c'est atteignable.

---

### Ce qui existe déjà (base saine)

CI actuel analysé — workflows identifiés : `ci.yml` (lint + typecheck + tests), `deps-audit.yml` (pnpm audit + Socket.dev daily), `axe.yml` (axe WCAG 2.2 + Lighthouse + Playwright E2E), `pgtap.yml` (pgTAP RLS), `zap-baseline.yml` (OWASP ZAP — scaffoldé, pas encore actif).

C'est déjà un pipeline CI au-dessus de 90% des startups. La base est là.

---

### Gap 1 — Observabilité : on sait que ça marche, pas pourquoi ni pour qui

**Ce que Netflix fait :** chaque service publie des SLIs mesurables. Les SLOs sont codifiés dans l'infra d'alerte (Atlas + Mantis chez Netflix, Datadog/Axiom chez vous). Un ingénieur peut savoir en 30 secondes si un service est dans son error budget ou l'a dépassé.

**Ce qui manque ici :**

- **Pas de SLOs dans Axiom.** La spec annonce `p99 < 500 ms` sur `/v1/reservations/book` et `99.9 %` de disponibilité. Ces valeurs ne sont définies dans aucune alerte, aucun dashboard. Elles n't existent que dans un document texte. Si p99 passe à 800 ms demain, personne ne le saura avant qu'un utilisateur se plaigne.

- **Pas de RUM (Real User Monitoring).** Lighthouse en CI mesure la performance sur une machine GitHub. Un utilisateur sur un iPhone SE en 4G dans un gymnase avec un signal faible vit une expérience différente. Vercel Analytics ou Sentry Performance permettent de mesurer le vrai LCP/FID/CLS du vrai trafic.

- **Pas de synthetic monitoring.** Un check actif qui appelle `/health` et `/v1/reservations` toutes les 60 secondes depuis 3 régions et alerte sur Slack si ça fail. Checkly ou Axiom Uptime font ça en 10 minutes de config. Sans ça, vous apprenez qu'un endpoint est cassé par un utilisateur, pas par une alerte.

- **Pas de cost monitoring.** Cloudflare Workers facture à la requête, Upstash à la commande Redis, Neon à la data. Sans un dashboard de coût par endpoint et par studio, la première surprise à l'échelle sera une facture mensuelle incompréhensible.

**Fix concret :**
```yaml
# Ajouter dans Axiom — SLO définition
slo:
  name: "reservations-book-latency"
  metric: "http.server.duration"
  filters: { "http.route": "/v1/reservations/book" }
  target: p99 < 500ms
  window: 30d
  alert_on: error_budget_burn_rate > 2x
```

---

### Gap 2 — Tests de performance : les SLOs sont crus sur parole

**Ce que Stripe fait :** chaque PR qui touche un endpoint critique déclenche un test de charge court (30s, 100 req/s) avec k6. Si p99 régresse de plus de 20%, la PR est bloquée. C'est une règle de merge, pas une recommandation.

**Ce qui manque ici :**

- **Zéro test de charge en CI.** `ci.yml` ne contient pas k6, Artillery, ou Autocannon. Les 807 tests passent, mais personne ne sait ce qui se passe sur `/v1/reservations/book` à 100 req/s simultanées. L'algorithme Redis DECR + Neon FOR UPDATE est précisément le code qui se casse sous contention — et il n'a jamais été chargé.

- **Pas de baseline de performance stockée.** Sans historique de p50/p95/p99 par endpoint, un refactor qui double la latence passe inaperçu.

- **EXPLAIN ANALYZE jamais exécuté en CI.** Les requêtes critiques (`bookClass`, `listClasses`, `cancelReservation`) ne sont pas analysées avec le plan d'exécution PostgreSQL sur un jeu de données réaliste (10 000 réservations, 500 classes).

**Fix concret :**
```javascript
// k6/book-class.js — 50 lignes, à ajouter dans le repo
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 50, stages: [
    { duration: '10s', target: 50 },
    { duration: '20s', target: 50 },
    { duration: '10s', target: 0 },
  ],
  thresholds: { 'http_req_duration{scenario:default}': ['p(99)<500'] },
};
```
```yaml
# ci.yml — ajout conditionnel sur les PRs touchant packages/reservations
- name: Load test (reservations)
  if: contains(steps.changed.outputs.files, 'packages/reservations')
  run: k6 run k6/book-class.js
```

---

### Gap 3 — Déploiement : aucun mécanisme de rollout progressif

**Ce que Netflix fait (Spinnaker) et Cloudflare fait (gradual deploys) :** un déploiement produit ne touche pas 100% du trafic immédiatement. Il commence à 1%, reste 10 minutes, si p99 et error rate sont stables il monte à 10%, puis 100%. Si une métrique dépasse le seuil : rollback automatique.

**Ce qui manque ici :**

- **Pas de canary deploy.** `wrangler deploy` envoie le nouveau code sur 100% du trafic d'un coup. Cloudflare Workers supporte les versions avec des pourcentages de trafic (`workers.dev` et versions API). Ce n'est pas câblé.

- **Feature flags non câblés.** GrowthBook est dans le design depuis la révision du 10/05. En date du 15/05, aucun appel `isEnabled(flag, context)` n'est visible dans le code source. Chaque nouvelle feature deployée est un tout-ou-rien pour tous les studios.

- **Pas de preview environment par PR.** `axe.yml` build le projet mais déploie sur une URL statique. Un système mature crée un Workers preview + un Neon branch par PR. CF Workers et Neon branch databases supportent tous les deux ça nativement. Un reviewer peut tester la feature sur une URL réelle avant le merge.

- **Rollback manuel.** Si un déploiement prod est cassé, la procédure actuelle est `wrangler rollback` lancé manuellement. Un rollback automatique déclenché sur un error rate > seuil sur 5 minutes n'existe pas.

**Fix concret pour preview PR :**
```yaml
# .github/workflows/preview.yml
- name: Deploy Workers preview
  run: wrangler versions upload --message "PR #${{ github.event.number }}"
- name: Create Neon branch
  run: |
    neon branches create --name "pr-${{ github.event.number }}" \
      --parent main
```

---

### Gap 4 — Sécurité CI : ce qui manque malgré ZAP et deps-audit

Le pipeline a OWASP ZAP (pas encore actif), pnpm audit daily, Socket.dev. C'est bien. Ce qui manque :

- **SAST (analyse statique du code source).** `deps-audit.yml` analyse les dépendances, pas le code produit. CodeQL (gratuit sur GitHub) ou Semgrep détectent les injections SQL, les secrets hardcodés, les patterns `eval`, les désérialisations dangereuses directement dans `packages/api/src`. Une seule commande à ajouter dans `ci.yml`.

- **Secret scanning actif.** `gitleaks` ou Trufflesecurity détectent les secrets accidentellement commités (tokens Upstash, clés JWT, DB_URL). Sans ça, un `git log` fuite une clé pour toujours même après suppression. Le commit reste dans l'historique.

- **ZAP toujours désactivé.** `zap-baseline.yml` existe depuis le hardening mais `ZAP_TARGET_URL` n'est pas encore configuré. Aucun staging vivant = aucun scan DAST actif. Les findings S3 restent non-vérifiés dynamiquement.

- **Pas de pentest planifié.** Les audits S1-S6 sont statiques. Un pentest externe (6-12 mois) sur un staging avec données synthétiques est le seul moyen de valider que la chaîne "HIBP + Turnstile + RLS + JWT + rate-limit" résiste à un attaquant outillé et motivé.

**Fix minimal immédiat :**
```yaml
# ci.yml — ajouter après typecheck
- name: SAST (CodeQL)
  uses: github/codeql-action/analyze@v3
  with:
    languages: typescript

- name: Secret scan
  uses: trufflesecurity/trufflehog@v3
  with:
    path: ./
    base: ${{ github.event.before }}
    head: HEAD
    extra_args: --only-verified
```

---

### Gap 5 — Architecture : trois fonctionnalités manquantes à la fondation

**A. Temps réel — absent**

L'affichage live des check-ins sur les bornes, les mises à jour du nombre de places restantes en temps réel pendant une ouverture de session populaire, les notifications "votre waitlist a avancé" — aucun de ces use cases n'est possible avec l'architecture actuelle (REST + polling).

Cloudflare Durable Objects sont la solution native. Un `ClassCapacityDO` par cours maintient le compteur en mémoire et pousse les updates via WebSocket ou SSE à tous les clients connectés. Upstash ne résout pas ça (Redis pub/sub en HTTP n'est pas du temps réel).

**B. Recherche full-text — absent**

Chercher "yoga" parmi les cours d'un studio, filtrer par coach, par horaire, par salle — aucune infrastructure de recherche. PostgreSQL `tsvector` + GIN index couvre les besoins MVP sans coût supplémentaire. Migration vers Typesense si les volumes le justifient.

**C. Multi-région DB — single point of failure**

Neon est configuré sur une seule région. Les Workers s'exécutent au edge global mais chaque requête DB retourne à la région Neon (probablement `us-east-1` ou `eu-central-1`). Pour un studio parisien qui ouvre les réservations à 8h, toutes les requêtes traversent l'Atlantique. Neon supporte les read replicas régionales. Le latency impact est mesurable : 15-20ms en Europe vs 80-120ms en cross-Atlantique.

---

### Gap 6 — Developer experience : friction qui ralentit l'équipe à l'échelle

- **Pas d'OpenAPI généré.** Les clients web et mobile dupliquent les types du backend manuellement. Hono supporte `@hono/zod-openapi` qui génère une spec OpenAPI 3.1 depuis les routes Zod. Un `openapi-typescript` downstream génère un client TypeScript typé pour les apps. Zéro drift de types entre backend et frontend.

- **Pas de versioning sémantique des packages internes.** `@athlya/shared` change sans version bump. Un changement breaking dans un schéma Zod se découvre au build, pas à la revue. Changesets (outil Turborepo) gère le versioning et le changelog automatiquement.

- **Pas de changelog automatisé.** `CHANGELOG.md` existe à la racine mais aucune tooling ne le remplit. Conventional commits + `changesets` génèrent le changelog à chaque release. L'historique des changements breaking est traçable.

- **Testcontainers Docker-gated sur Windows.** Les 8 suites avec Testcontainers skipent sur votre poste. L'alternative : `pg-mem` (in-memory PostgreSQL) pour les tests de schéma Zod/Drizzle, Testcontainers uniquement en CI Linux. Ça résout le gap "PBT P1/P4/P7 validées sur confiance".

---

### Gap 7 — Fiabilité : les patterns qui manquent

- **Retry avec exponential backoff + jitter.** Aucun adapter (Neon, Upstash, Resend) n'implémente de retry. Si Neon retourne une erreur transitoire 503, la requête fail sans retry. Stripe, Cloudflare, et toutes les librairies HTTP des GAFAM implémentent des retries avec `delay = base * 2^attempt + jitter(0, base)`. `p-retry` ou une implementation manuelle en 20 lignes.

- **Bulkhead pattern.** Le Workers gateway traite `/v1/reservations`, `/v1/billing`, `/v1/auth` et `/v1/members` sur le même Worker. Un bug dans le billing handler qui consomme 200ms de CPU bloque les slots disponibles pour les réservations. Les Durable Objects ou des Workers séparés par domaine cloisonnent les failures.

- **Timeouts explicites sur chaque adapter.** Aucun timeout n'est visible sur les calls Neon ou Upstash. Le Worker a un timeout global de 30s CPU mais pas de timeout par dépendance. Si Neon prend 25s sur une requête, la réponse finale arrive à 25s. Un `AbortSignal.timeout(5000)` sur chaque call dépendance garantit que le circuit breaker a une chance de s'ouvrir avant le timeout global.

---

### Récapitulatif "ce qui manque" par impact

| Catégorie | Item | Impact prod | Effort |
|-----------|------|-------------|--------|
| Observabilité | SLOs dans Axiom | Critique | 1 jour |
| Observabilité | Synthetic monitoring (Checkly) | Critique | 2h |
| Performance | k6 en CI sur routes critiques | Critique | 1 jour |
| Déploiement | Feature flags GrowthBook câblés | Élevé | 2 jours |
| Déploiement | Preview envs par PR (Workers + Neon branch) | Élevé | 1 jour |
| Sécurité | SAST CodeQL + gitleaks en CI | Élevé | 2h |
| Sécurité | ZAP activé sur staging | Élevé | 1h (quand staging up) |
| Fiabilité | Retry + jitter sur adapters Neon/Upstash | Élevé | 4h |
| Fiabilité | Timeouts explicites par dépendance | Élevé | 2h |
| Architecture | Real-time (Durable Objects) | Moyen | 3 jours |
| Architecture | Recherche full-text (PG tsvector) | Moyen | 1 jour |
| Architecture | Read replica Neon EU | Moyen | 2h config |
| DX | OpenAPI généré + client typé | Moyen | 2 jours |
| DX | Changesets + changelog auto | Faible | 4h |
| DX | Testcontainers → pg-mem en local | Faible | 2 jours |

### Verdict final

**Ce projet est déjà au niveau d'une startup Série A bien gérée.** Les 5 gaps critiques (SLOs, synthetic monitoring, k6, feature flags, SAST) représentent environ **4 jours de travail** et font passer le projet au niveau d'une équipe produit de 10-15 ingénieurs chez une licorne.

Ce que Netflix a en plus que vous n'aurez jamais besoin avant 100 000 utilisateurs actifs : multi-région actif-actif, Chaos Monkey automatisé, 50 000 tests de regression, CDN propriétaire. C'est de l'échelle, pas de la qualité d'ingénierie.

La qualité d'ingénierie, elle, est atteignable maintenant.

---

## Analyse concurrentielle — 15/05/2026

> **Contexte :** Athlya est open source. L'objectif de cette section n'est pas commercial — c'est de s'inspirer des UX et fonctionnalités que les concurrents ont validées sur de vrais utilisateurs, pour ne pas réinventer ce qui marche déjà. Les comparaisons de prix ci-dessous sont indicatives (elles montrent ce que les studios paient aujourd'hui et donc ce qu'ils apprécient assez pour payer), pas un positionnement tarifaire.

---

### Panorama des concurrents directs

| App | Modèle | Marché cible | Points forts | Faiblesses connues |
|-----|--------|-------------|-------------|-------------------|
| **Mindbody** (USA) | SaaS B2B, ~180$/mois | Salles de sport, spas, yoga | API partenaires, marketplace d'apps, paiement intégré, booking client | Interface vieillissante, onboarding long (2-4 semaines), prix prohibitif pour les petits studios |
| **Basic Fit** (app interne) | B2C, grande chaîne | Chaîne low-cost EU | UX mobile simple, réservation rapide, check-in QR | Mono-tenant par design, aucune API tierce, pas de marketplace |
| **Gymlib** (France) | B2B2C, flex | Avantages salariés | Réseau multi-salles, paiement mixte employeur/employé | Studio reçoit peu d'argent, pas de relation directe, marges faibles |
| **Classbooker** (UK) | SaaS B2B, ~50$/mois | Petits studios UK | Prix bas, simple, multilingue | Pas de mobile app native, analytics limités |
| **Glofox** (Irlande) | SaaS B2B, ~100-250$/mois | Boutique fitness, CrossFit | Bonne UX studio admin, app mobile marque blanche | Support lent, pas de webhooks avancés, reporting faible |
| **WellnessLiving** | SaaS B2B | Canada/USA | CRM intégré, fidélisation, check-in borne | Complexe à configurer, UX 2015 |
| **Kenko** (UK/EU) | SaaS B2B, récent | Studios modernes | Design moderne, onboarding rapide | Jeune, fonctionnalités manquantes, pas de marketplace |

**Athlya se positionne** entre Glofox (tarif) et Mindbody (fonctionnalités) avec un avantage structurel que personne n'a : **multi-tenant isolé dès la conception** (RLS PostgreSQL). Chaque studio est une forteresse de données — RGPD by design, pas en patch.

---

### Ce qu'on peut prendre des concurrents

#### De Mindbody — 3 idées concrètes

**1. Marketplace d'intégrations** (priorité : haute)
Mindbody a 200+ intégrations (Zoom, Mailchimp, Zapier, Stripe, Shopify). Les studios veulent connecter leurs outils existants sans changer de stack. Athlya a déjà les webhooks outbound dans le backlog. La prochaine étape : une page "Intégrations" dans le studio admin avec des connecteurs one-click (Zapier/Make.com d'abord, puis natifs).

**2. Client marketplace / annuaire** (priorité : moyenne)
Mindbody permet aux clients de découvrir de nouveaux studios via leur app. C'est de l'acquisition gratuite pour les studios. Athlya pourrait proposer un annuaire opt-in `athlya.app/studios/{ville}` indexé par Google. Coût d'implémentation : 1 semaine. ROI : les studios qui s'inscrivent amènent leurs clients qui découvrent l'annuaire.

**3. Check-in borne / QR code** (priorité : haute)
Mindbody a une borne physique à l'accueil. C'est simple : un QR code sur le téléphone du membre, scanné par l'iPad du studio. Athlya a l'architecture temps réel (prévue avec Durable Objects) qui rend ça trivial. Afficher les membres du cours en temps réel sur une borne = feature que les petits studios adorent et que Mindbody vend à 50$/mois.

#### De Glofox — 2 idées

**4. App mobile marque blanche** (priorité : haute)
Glofox vend aux studios "votre propre app iOS/Android avec votre logo". C'est une vraie valeur pour la rétention des membres (l'app est dans le dock du téléphone, pas perdue dans un navigateur). React Native + Expo avec un theming par tenant. Athlya est une PWA aujourd'hui, une app marque blanche est la v0.3 naturelle.

**5. Programme de fidélité / points** (priorité : moyenne)
Glofox et WellnessLiving ont des systèmes de points (10 cours = 1 cours gratuit, badge "100 cours"). Très faible coût d'implémentation côté DB (une table `loyalty_points`), fort impact sur la rétention. Le billing Stripe existant peut déclencher les crédits automatiquement via l'event bus.

#### De Basic Fit — 1 idée

**6. Réservation en 3 secondes** (priorité : critique)
Basic Fit a le flow de réservation le plus rapide du marché : 3 taps, aucun formulaire, aucune confirmation email obligatoire. L'UX Athlya doit être au moins aussi rapide. Techniquement c'est OK (idempotency key + optimistic UI), mais il faut le mesurer : le flow register → book doit s'exécuter en < 3s sur mobile 4G moyen. Playwright E2E doit mesurer ce temps et fail si > 3s.

#### De Gymlib — 1 idée (modèle business, pas technique)

**7. Partenariat entreprises / avantages salariés** (priorité : basse, mais différenciant)
Gymlib fait 80% de son CA en vendant aux DRH d'entreprises (avantage salarié). Athlya pourrait proposer aux studios de créer des "codes entreprise" (un token de réduction ou d'accès illimité financé par l'employeur). Côté infra : un type de `voucher` dans le billing Stripe + un endpoint `/v1/vouchers/redeem`. 2 semaines d'implémentation, potentiel d'acquisition B2B.

---

### Ce qu'Athlya peut faire mieux que tous

| Avantage Athlya | Pourquoi les concurrents ne peuvent pas copier facilement |
|-----------------|----------------------------------------------------------|
| **Multi-tenant RLS dès v0.1** | Mindbody/Glofox ont été construits monolithiques — retrofitter du RLS sur 15 ans de code est un projet de 2 ans |
| **Déploiement edge global (CF Workers)** | Leurs backends tournent sur des serveurs régionaux (us-east-1 principalement). Un studio au Japon ou au Brésil reçoit ses requêtes depuis une VM à 200ms |
| **Coût d'infra 80-250€/mois** | Mindbody charge 180$/mois min par studio. Athlya peut être rentable à 30$/mois par studio et garder 70% de marge |
| **Webhooks outbound natifs** | Aucun concurrent à moins de 100$/mois n'a des webhooks documentés avec signature HMAC |
| **Idempotency native** | Aucun concurrent ne garantit l'absence de double-booking sous contention — Athlya oui (Redis + DB FOR UPDATE) |

---

### Roadmap inspirée des concurrents — ordre de priorité

1. **Check-in QR code** — Semaine 1 post-MVP. Feature signature, visible à l'accueil, photo-worthy.
2. **Flow réservation < 3s** — Mesurable avant launch. Playwright E2E avec threshold.
3. **App marque blanche (PWA → Expo)** — v0.2. Différenciant vs Glofox pour les studios premium.
4. **Marketplace d'intégrations (Zapier/Make)** — v0.2. Zapier webhook trigger en 2 jours, catalog natif v0.3.
5. **Fidélité / points** — v0.2. Rétention +30% selon les études Glofox.
6. **Annuaire public studios** — v0.3. Acquisition gratuite.
7. **Codes entreprise / avantages salariés** — v0.3. Canal B2B.

---

### Note de l'analyse : honnêteté sur les risques

**Risque principal :** Mindbody a annoncé une refonte UX et une API v3 en 2025. Si elle livre une interface moderne + prix baissés, le positionnement "Mindbody mais abordable" s'érode. **Contreattaque :** le différenciant RLS/edge/coût reste structurel, pas UX. Un Mindbody plus joli ne change pas son architecture mono-tenant ni ses coûts d'infra.

**Risque secondaire :** Kenko (UK) est récent, bien financé, design moderne. Surveiller leur roadmap Q3 2026. Si leur architecture est multi-tenant propre, ils sont le concurrent le plus dangereux à 18 mois.

---

## Inspiration hors vertical fitness — ce que les grandes apps font et qu'Athlya n'a pas

> L'idée : ne pas chercher l'inspiration que chez les concurrents directs. Les meilleures features d'Athlya seront probablement copiées d'apps que les studios et leurs membres utilisent tous les jours.

---

### Airbnb / Booking.com — Découverte et confiance

**Ce qu'ils ont :**
- Système d'avis bidirectionnel (membre note le cours, studio peut noter le membre)
- Fiche studio avec photos, bio coach, horaires, certifications
- Recherche par carte, par filtre (yoga/crossfit/pilates, proche de moi, places dispo ce soir)

**Ce qu'Athlya n'a pas :**
- **Aucun système de review.** Un membre ne peut pas noter un cours. Le studio n'a aucun signal de qualité. La fiche `GET /v1/classes/:id` retourne des métadonnées mais zéro social proof.
- **Aucune recherche géographique.** Trouver un studio proche de sa position GPS actuelle n'est pas possible — ni côté schéma DB (pas de colonne `coordinates`), ni côté API.
- **Aucune photo de cours.** Les fiches cours sont textuelles. Une image de la salle + du coach = +60% de taux de réservation (chiffre Mindbody 2023).

**Fix concret (par priorité) :**
1. `reviews` table : `memberId`, `classId`, `rating (1-5)`, `comment`, `createdAt`. Agrégat `avgRating` dénormalisé sur `classes`. 2 jours.
2. Colonne `coordinates POINT` sur `studios`. Index GiST. Query `ORDER BY coordinates <-> ST_Point($lng, $lat)`. PostGIS ou `earthdistance` extension. 1 jour.
3. Upload d'images via Cloudflare R2 (déjà dans l'éco-système CF). 2 jours.

---

### Duolingo / Strava — Rétention par la gamification

**Ce qu'ils ont :**
- **Strava :** activités partagées, feed social, segments ("KOM"), challenges mensuels, stats annuelles
- **Duolingo :** streak quotidien, XP, ligue hebdomadaire, notifications de rappel intelligentes

**Ce qu'Athlya n'a pas :**
- **Zéro gamification.** Un membre qui vient 3x par semaine depuis 6 mois n'a aucune trace visible de son parcours. Pas de compteur de séances, pas de badge "50 cours", pas de streak.
- **Zéro social entre membres.** Voir qui d'autre est inscrit à un cours (opt-in) crée de l'engagement. Strava prouve que le social dans le sport = rétention.
- **Zéro notification intelligente.** "Tu n'es pas venu depuis 7 jours" ou "Le yoga du mardi a encore 2 places" envoyés au bon moment = retention tool puissant. L'infra notification (Resend + event bus) est là, mais aucun trigger de ce type n'est défini.

**Fix concret :**
1. Table `member_stats` : `totalClasses`, `currentStreak`, `longestStreak`, `lastClassAt`. Mise à jour via event `class.checked_in` sur le bus existant. 1 jour.
2. Badges calculés côté DB (matérialisés). Affichés sur le profil membre. 1 jour.
3. Event `member.inactive_7d` déclenché par un CF Workers cron daily. Consumer notifications existant. 4h.

---

### Calendly — Expérience de booking sans friction

**Ce qu'ils ont :**
- Widget embeddable sur n'importe quel site (`<script>` tag, iframe)
- Lien de booking partageable (calendly.com/nom/type-de-rdv)
- Gestion des timezones transparente
- Export iCal / sync Google Calendar / Outlook

**Ce qu'Athlya n'a pas :**
- **Pas de widget embeddable.** Un studio avec son propre site WordPress ne peut pas mettre un bouton "Réserver" qui ouvre le booking Athlya. Ils doivent rediriger vers une URL séparée.
- **Pas de lien partageable par cours.** Un coach ne peut pas envoyer `athlya.app/book/yoga-mardi-20h` par SMS à ses membres.
- **Pas de sync calendrier.** Après une réservation, aucun `.ics` n'est généré. Le membre ne peut pas ajouter le cours à Google Calendar en un clic.

**Fix concret :**
1. Générer un fichier `.ics` à la confirmation de réservation. 20 lignes de code, impact fort. 2h.
2. URL canonique par cours `athlya.app/s/{studioSlug}/c/{classSlug}`. Page publique statique avec bouton "Réserver". 1 jour.
3. Widget JS (`<script src="athlya.app/widget.js" data-studio="slug">`) — iframe sandboxée, déployable sur CF Pages. 3 jours.

---

### Stripe — Qualité du dashboard développeur / opérateur

**Ce qu'ils ont :**
- Log de chaque webhook envoyé avec payload, status code, latence, bouton "retry"
- Dashboard temps réel des events entrants (live stream)
- Clés API par environnement avec permissions granulaires

**Ce qu'Athlya n'a pas :**
- **Le dashboard admin `/admin` est technique** (DLQ stats, routes internes). Il n'y a pas de dashboard studio qui montre : revenus de la semaine, cours les plus remplis, membres qui annulent le plus, heure de pic de réservation.
- **Aucun log visible pour le studio des webhooks sortants.** Si un webhook vers leur système tiers échoue, ils ne peuvent pas le voir ni le rejouer sans appeler le support.
- **Aucune clé API par tenant.** Un studio qui veut intégrer son propre système ne peut pas générer une API key avec des permissions limitées (read-only sur ses propres cours). Tout passe par l'auth JWT membre.

**Fix concret :**
1. Vue `StudioDashboard` : 4 métriques clés (revenus 7j, taux de remplissage moyen, membres actifs, cours annulés). Données depuis une query Drizzle, pas de BI externe. 2 jours.
2. Table `webhook_deliveries` : `webhookId`, `payload`, `statusCode`, `attemptAt`, `nextRetryAt`. UI de replay dans le studio admin. 2 jours.
3. Clés API tenant : table `api_keys` avec `tenantId`, `hashedKey`, `permissions[]`, `expiresAt`. Auth middleware lit cette table en fallback du JWT. 2 jours.

---

### Linear / Vercel — Vitesse d'interface = respect du temps de l'utilisateur

**Ce qu'ils ont :**
- Chaque action répond < 100ms (optimistic UI, pas d'attente réseau visible)
- Raccourcis clavier sur tout (Linear : `C` pour créer, `E` pour modifier)
- Command palette (`cmd+K`) qui permet de tout faire sans souris

**Ce qu'Athlya n'a pas :**
- **L'UI web n'est pas encore construite** (Epic 10 à venir), donc c'est le bon moment pour intégrer ces patterns avant, pas après.
- Mais l'architecture backend le permet déjà : idempotency keys + optimistic UI côté React = réservation affichée instantanément, confirmée en arrière-plan.

**À intégrer dès Epic 10 :**
- Optimistic updates sur la liste de cours (place décrémentée avant la réponse serveur, rollback si 409).
- `cmd+K` pour chercher un cours, réserver, annuler — sans navigation.
- Chaque page de l'admin studio doit se charger < 200ms (CF Workers edge = pas d'excuse).

---

### Résumé — ce qui manque, trié par impact / effort

| Feature | Inspiré de | Impact rétention | Effort |
|---------|-----------|-----------------|--------|
| Export `.ics` / sync calendrier | Calendly | Fort | 2h |
| Streak + compteur de séances | Duolingo/Strava | Fort | 1 jour |
| Notification "inactif 7 jours" | Duolingo | Fort | 4h |
| Lien partageable par cours | Calendly | Fort | 1 jour |
| Système de reviews | Airbnb | Moyen-fort | 2 jours |
| Dashboard studio (métriques) | Stripe | Fort (rétention studio) | 2 jours |
| Recherche géographique | Airbnb | Moyen | 1 jour |
| Photos de cours | Airbnb | Moyen | 2 jours |
| Webhook delivery log + replay | Stripe | Moyen (technicité) | 2 jours |
| Widget embeddable | Calendly | Moyen | 3 jours |
| Optimistic UI + cmd+K | Linear/Vercel | Fort (perçu) | À intégrer Epic 10 |
| Clés API par tenant | Stripe | Faible MVP, fort v0.3 | 2 jours |

---

## Inspiration round 2 — 15/05/2026

### WhatsApp / Telegram — Le bon canal de notification

**Ce qu'ils ont :** En Europe, les gens ouvrent WhatsApp en 3 minutes, un email marketing en 3 jours. Duolingo a migré une partie de ses rappels vers WhatsApp Business et a observé un taux d'ouverture de 80% vs 20% email.

**Ce qu'Athlya n'a pas :**
- Le consumer de notifications (`packages/notifications/src/consumer.ts`) n'envoie que des emails via Resend. Aucun canal SMS/WhatsApp.
- Pas de préférence de canal par membre (certains veulent email, d'autres SMS, d'autres WhatsApp).

**Fix concret :**
- `channel` enum sur `notification_preferences` : `email | sms | whatsapp`. Consumer route selon la préférence.
- Twilio pour SMS (simple, API stable). WhatsApp Business API via Meta directement ou via Twilio (même SDK). 2 jours.
- Impact immédiat : rappel 1h avant le cours via SMS = -40% de no-show (chiffre moyen secteur fitness).

---

### Uber — Position en file d'attente visible

**Ce qu'ils ont :** Uber affiche "2 minutes" en temps réel. L'attente devient tolérable quand elle est visible. Sans information, l'utilisateur annule.

**Ce qu'Athlya n'a pas :**
- La waitlist est dans l'architecture mais le membre ne voit pas "vous êtes #3 sur liste d'attente".
- Pas de notification push quand la position change (quelqu'un annule → #3 devient #2).
- Pas de délai d'acceptation : si une place se libère, le #1 a X minutes pour confirmer avant que ça passe au #2.

**Fix concret :**
- Colonne `waitlistPosition` calculée en temps réel (CF Durable Object `ClassCapacityDO` déjà prévu). Exposée dans `GET /v1/reservations/:id`.
- Event `waitlist.position_changed` → notification consumer existant. 1 jour.
- `waitlist_expiry_minutes` configurable par studio (5 min par défaut). CF Workers scheduled trigger. 4h.

---

### Typeform — Formulaire de santé/consentement par cours

**Ce qu'ils ont :** Chaque inscription à un cours peut requérir des infos spécifiques : blessures pour CrossFit, semaine de grossesse pour yoga prénatal, niveau pour les cours avancés. Typeform a prouvé que les formulaires conversationnels (une question à la fois) ont un taux de complétion 3x supérieur aux formulaires classiques.

**Ce qu'Athlya n'a pas :**
- Aucun système de formulaire pré-inscription.
- Aucun consentement numérique au RGPD/responsabilité stocké avec la réservation.
- Légalement, un studio fitness doit pouvoir prouver que le membre a déclaré ne pas avoir de contre-indication médicale.

**Fix concret :**
- Table `class_intake_forms` : `classId`, `questions (JSONB)`, `required`.
- Réponses stockées dans `reservations.intakeAnswers (JSONB)`. Immutables après soumission.
- UI conversationnelle (une question = un écran) dans le flow de réservation. 1-2 jours.
- Ce champ `intakeAnswers` est un document légal — RLS le protège, seul `athlya_owner` peut y accéder hors scope.

---

### Peloton / Apple Fitness+ — Cours hybrides (présentiel + streaming)

**Ce qu'ils ont :** Post-COVID, les studios qui ont survécu proposent du présentiel + Zoom simultané. Peloton a construit son empire sur le streaming seul. La tendance est au "hybrid" : même cours, accessible en salle ou depuis le canapé.

**Ce qu'Athlya n'a pas :**
- Un champ `streamUrl` n'existe pas sur `classes`.
- Aucun contrôle d'accès : si un lien Zoom est dans la fiche cours, tous peuvent le voir (membres inscrits, non-inscrits, crawlers).
- Aucune gestion de capacité hybride : 10 places physiques + 50 places streaming = deux compteurs différents.

**Fix concret :**
- Colonne `streamUrl TEXT ENCRYPTED` sur `classes` (chiffré via `pgcrypto`). Déchiffré uniquement dans `GET /v1/reservations/:id` après confirmation de réservation. 4h.
- Deux compteurs de capacité : `maxCapacityInPerson` + `maxCapacityOnline`. Même idempotency key + Redis pour les deux. 1 jour.
- Ouvre un marché entier : un coach indépendant peut créer un studio Athlya, donner des cours en ligne à 100 personnes, sans local physique.

---

### Résumé round 2 — par impact / effort

| Feature | Inspiré de | Impact | Effort |
|---------|-----------|--------|--------|
| SMS/WhatsApp rappels avant cours | WhatsApp | Fort (-40% no-show) | 2 jours |
| Position waitlist temps réel | Uber | Fort | 1 jour |
| Délai d'acceptation waitlist | Uber | Moyen | 4h |
| Formulaire santé/consentement | Typeform | Fort (légal) | 2 jours |
| Cours hybride présentiel+streaming | Peloton | Fort (nouveau marché) | 1-2 jours |

---

## Stratégie open source — 15/05/2026

> Ce qui différencie les projets open source qui ont une communauté de ceux qui végètent n'est pas la qualité du code. C'est l'accessibilité.

### Ce qui manque

**1. Démo live permanente**
Supabase a `app.supabase.com`, Vercel a `vercel.com/new`. Pour Athlya : un `demo.athlya.app` avec de fausses données, accessible sans inscription, que n'importe qui peut explorer immédiatement. Coût : 0 (CF Workers free tier). Impact : un développeur évalue en 5 minutes s'il veut contribuer.

**2. Setup local en 1 commande**
Athlya nécessite actuellement : configurer Neon, Upstash, Cloudflare, générer des clés JWT, configurer Resend. C'est 2h pour un nouveau contributeur. Un script `pnpm setup:local` qui démarre une DB SQLite locale + Redis in-memory + secrets de dev pré-générés = la différence entre 0 et 100 contributeurs potentiels. Prisma et Next.js font ça depuis le premier jour.

**3. Roadmap publique**
`project.md` est de la doc interne. Un GitHub Projects ou un `ROADMAP.md` lisible par n'importe qui = les contributeurs savent sur quoi travailler sans demander.

**4. "Good first issues" taguées**
Sans issues taguées, un contributeur qui veut aider ne sait pas par où commencer. Les projets avec des `good first issue` reçoivent 3x plus de PRs externes.

**5. Documentation utilisateur (pas dev)**
`docs/` est de la doc interne de dev. Pas de "getting started en 15 minutes" pour un studio qui veut déployer Athlya. La doc dev IS le produit pour un projet open source — personne ne contribue à ce qu'il ne comprend pas.

**6. Changelog public**
`CHANGELOG.md` existe mais n'est pas généré automatiquement (Changesets est dans le backlog). Une page `athlya.app/changelog` statique avec les releases = reconnaissance pour les contributeurs. Un contributeur dont la PR est mentionnée dans un changelog revient.

### Résumé : paradoxe actuel

Tout le code de qualité d'Athlya est invisible pour un contributeur potentiel qui ne peut pas le faire tourner en 10 minutes.

| Pratique open source | Exemple | Athlya aujourd'hui |
|---------------------|---------|-------------------|
| Demo live sans installation | Supabase, Vercel | Absent |
| Setup local 1 commande | Next.js, Prisma | Absent (2h de config) |
| Roadmap publique | Astro, Linear | Absent |
| Good first issues | React, Vue | Absent |
| Doc utilisateur | Stripe | Absent |
| Changelog auto | Raycast, Linear | Absent (Changesets prévu) |

---

## Audit structurel — 15/05/2026

> Hors features, hors open source. Ce qui concerne la forme du code, la testabilité, et les patterns qui créent de la friction à l'échelle.

### 1. Monorepo : les packages sont trop couplés au runtime Cloudflare

`packages/api`, `packages/auth`, `packages/ratelimit` importent des types Cloudflare (`ExecutionContext`, `KVNamespace`, `Queue`) directement dans leurs interfaces. Si un jour quelqu'un veut déployer Athlya sur un VPS Node.js ou sur AWS Lambda, ces types bloquent à la compilation.

**Pattern manquant :** port/adapter strict. Les interfaces des packages core ne doivent pas connaître Cloudflare. Un `interface IQueue { send(msg: unknown): Promise<void> }` est neutre. L'implémentation CF est un adapter. Drizzle et Hono font ça bien. Le reste du code non.

**Impact :** aujourd'hui académique. En v0.3 quand quelqu'un voudra auto-héberger Athlya sur Docker, ça sera le premier bloquant.

### 2. Schéma DB et domaine métier vivent dans le même package

`packages/db/src/schema/` contient les tables Drizzle ET des helpers métier. Si on change de base (Turso, PlanetScale, SQLite pour les tests) ou si on extrait le domaine pour le tester sans DB, tout est couplé.

**Pattern manquant :** séparer `packages/db` (infrastructure : connexion, migrations, schéma brut) de `packages/domain` (entités métier : `Reservation`, `Class`, `Member` avec leurs règles). Le domaine ne doit rien savoir de Drizzle.

**Impact :** les tests unitaires de `packages/reservations` ont besoin d'un vrai Drizzle client aujourd'hui. Avec un domaine isolé, `book()` s'unit-teste avec un objet JS pur, sans DB.

### 3. Pas de versioning d'API

L'API est à `/v1/`. Il n'y a pas de stratégie pour `/v2/`. Quand un breaking change sera nécessaire (et il le sera), comment les clients anciens sont-ils maintenus ? Stripe supporte des versions d'API datées depuis 2014 — un header `Stripe-Version: 2024-12-18` et la réponse s'adapte. Athlya n'a aucun mécanisme.

**Fix minimal :** documenter dans `packages/api/README.md` la politique de dépréciation avant qu'il soit trop tard. "Toute breaking change = nouveau préfixe `/v2/`, `/v1/` maintenu 6 mois." Ce n'est pas du code, c'est un engagement écrit maintenant pendant qu'il n'y a pas de clients à casser.

### 4. Les events du bus ne sont pas versionnés

`packages/shared/src/events.ts` définit les types d'events (`class.booked`, `member.created`, etc.). Si le schéma d'un event change (ajout d'un champ obligatoire), les consumers qui ont déjà des messages en queue reçoivent un event qui ne match plus le schéma courant. Crash garanti.

**Pattern manquant :** versionning d'events. `{ type: 'class.booked', version: 1, payload: {...} }`. Consumer déclare les versions qu'il supporte. Messages d'une version inconnue sont mis en DLQ, pas crashés. Kafka et tous les event buses sérieux font ça.

### 5. Pas de boundary entre les packages

N'importe quel package peut importer n'importe quel autre. `packages/billing` pourrait importer `packages/notifications` directement. Turborepo ne bloque pas ça, ESLint non plus.

**Fix :** règle ESLint `import/no-restricted-paths` qui encode le graphe de dépendances autorisé. Si `billing` importe `notifications` sans passer par le bus d'events, le lint fail. 1 journée pour coder la règle + documenter l'architecture dans un `ARCHITECTURE.md`.

### 6. `unknown` comme type de retour sur le chemin critique

`BookingTx = unknown` dans `packages/reservations/src/book.ts` (identifié en révision 15/05 code). C'est le type de la transaction Drizzle qui exécute la réservation. Si quelqu'un refactor Drizzle et change le type de retour, TypeScript ne détecte rien — l'erreur se découvre en runtime en production.

C'est symptomatique d'un pattern plus large : les types `unknown` et `as any` aux frontières entre packages indiquent que les contrats d'interface ne sont pas formalisés. Un `BookingResult = { reservationId: string; classId: string; memberId: string; seatsRemaining: number }` explicite + le type Drizzle inféré = 0 ambiguïté.

### Résumé structurel

| Problème | Impact | Effort fix |
|----------|--------|------------|
| Couplage types CF dans packages core | Bloquant pour auto-hébergement | 3-5 jours |
| Schéma DB = domaine métier | Tests unitaires nécessitent DB | 3 jours (refactor progressif) |
| Pas de versioning API | Breaking changes incontrôlées | 0 code — 1 politique écrite |
| Events non versionnés | Crash en rolling deploy | 1 jour |
| Pas de boundary packages | Couplages silencieux | 1 jour (règle ESLint) |
| `unknown` sur chemins critiques | Bugs runtime invisibles | 4h (audit + typage) |

---

## Angles non couverts — 15/05/2026

### Légal — 2 obligations pas des features

**RGPD Article 20 : portabilité des données — absent**
Un membre peut légalement demander l'export de toutes ses données (réservations, paiements, profil) en format lisible (JSON ou CSV). Aucun endpoint n'existe pour ça. L'absence est une infraction, pas une dette technique. Un `GET /v1/me/export` qui génère un ZIP via CF Workers + R2 = 1 journée. À livrer avant le premier utilisateur réel, pas en v0.3.

**European Accessibility Act (EAA) — deadline juin 2025**
La directive EU 2019/882 est entrée en vigueur pour les nouvelles apps en juin 2025. Les apps de services en ligne doivent être conformes WCAG 2.2 AA. Athlya a axe + Lighthouse en CI — excellent. Mais l'UI (Epic 10) n'est pas encore construite. Le risque : construire l'UI d'abord, corriger a11y ensuite. L'approche inverse (ARIA patterns, focus management, keyboard nav dès la maquette) coûte 0 en retard et évite une refonte douloureuse.

---

### i18n — décision structurelle à prendre maintenant, pas en v0.3

`@athlya/shared` a des bundles i18n. Mais les décisions suivantes ne sont pas documentées :

- **Timezone par studio ou par membre ?** Un studio à Paris, un membre en voyage à Bruxelles — l'heure du cours est stockée en UTC, affichée dans quel fuseau ? Réponse actuelle dans le code : inconnue.
- **Formats de date** : `DD/MM/YYYY` (France) vs `MM/DD/YYYY` (si on veut l'international) — aucune convention dans les réponses API.
- **Pluriels** : "1 place restante" vs "2 places restantes" — Intl.PluralRules, pas une concaténation de string. La fondation i18n shared existe, mais l'usage dans l'API et l'UI n'est pas défini.

Retrofitter la timezone sur une base de réservations existante = migration de données + bugs d'horaires = incidents en production. La décision doit être prise avant Epic 10.

---

### API mobile-first — les réponses ne sont pas conçues pour le mobile

L'API répond des objets complets. Un `GET /v1/classes` retourne probablement tous les champs d'une classe. Sur mobile 4G dans un vestiaire :

- **Pas de field selection** (`?fields=id,title,startAt,seatsRemaining`). La liste de cours charge plus que nécessaire.
- **Pagination par offset** — standard mais cassé sous insertion concurrente (une nouvelle classe insérée décale toutes les pages suivantes). Cursor-based pagination (`?after=<lastId>`) = stable pour l'infinite scroll mobile.
- **Pas de `ETag` / `Last-Modified`** sur les resources stables (liste des cours du jour). CF Workers peut servir depuis le cache edge sans toucher Neon si le `Cache-Control` + `ETag` sont bien positionnés.

Ces trois points ne nécessitent pas de refactor architectural — ils se configurent en ajoutant des middlewares Hono et en ajustant les queries Drizzle.

---

### Gestion des erreurs silencieuses dans Workers

`ctx.waitUntil(promise)` est utilisé pour les fire-and-forget (logs OTel, flush Sentry). Si la promise reject, Cloudflare l'avale silencieusement — aucune trace dans Axiom, aucune alerte. C'est documenté dans le JSDoc mais pas défendu dans le code.

```typescript
// Actuel — erreur silencieuse
ctx.waitUntil(flushOtel(span));

// Correct — erreur capturée
ctx.waitUntil(
  flushOtel(span).catch(err => console.error('[otel-flush]', err))
);
```

Chaque `ctx.waitUntil()` du codebase doit avoir un `.catch()` qui au minimum logue l'erreur. Un grep sur `ctx.waitUntil` sans `.catch` = liste des bombes silencieuses.

---

### Résumé des angles non couverts

| Angle | Type | Priorité | Effort |
|-------|------|---------|--------|
| RGPD Art. 20 export données | Légal obligatoire | Avant launch | 1 jour |
| EAA a11y dès Epic 10 | Légal + UX | Pendant Epic 10 | 0 (si intégré dès le début) |
| Timezone strategy documentée | Décision structurelle | Avant Epic 10 | 0 code — 1 ADR écrit |
| Field selection API | Mobile perf | v0.2 | 4h |
| Cursor-based pagination | Mobile perf | v0.1 | 4h |
| ETag / Cache-Control sur reads | Perf edge | v0.1 | 4h |
| ctx.waitUntil sans .catch | Bug silencieux | Immédiat | 2h (grep + fix) |