# Audit Sécurité S2 — Authentication & Authorization

Date : 2026-05-15
Périmètre : `packages/auth/*`, `packages/api/src/middleware/*`, `packages/api/src/routes/*`, `packages/api/src/adapters/auth-*`, flux refresh / RBAC / multi-tenant / Turnstile / HIBP / login throttle.
Méthode : revue statique du code, lecture des tests d'intégration, traçage du wiring `worker.ts` → routes → adapters. Aucun test runtime exécuté ici (les tests unitaires Vitest existants ont été lus pour confirmer le comportement).

---

## Résumé exécutif

| Sévérité | Findings | Marqueur                 |
| -------- | -------- | ------------------------ |
| CRITICAL | 3        | tous PROD-RISK           |
| HIGH     | 5        | tous PROD-RISK           |
| MEDIUM   | 5        | 4 PROD-RISK / 1 DEV-ONLY |
| LOW      | 4        | 2 PROD-RISK / 2 DEV-ONLY |
| INFO     | 3        | DEV-ONLY                 |

**Verdict** : la cryptographie sous-jacente (`jose` + RS256 + JWKS local) est correctement utilisée et les primitives (HIBP fail-closed, throttle sliding-window, password timing-uniforme) sont bien isolées et testées. **Le problème principal n'est pas la qualité des primitives mais leur câblage** : plusieurs garde-fous sécuritaires existent dans `@athlya/auth` mais ne sont jamais branchés dans `worker.ts` ou dans `auth-deps.ts`. Une attaque brute-force sur `/v1/auth/login` ne rencontre actuellement aucun rempart côté gateway.

**Score global : 58 / 100** (cf. détail en fin de document).

---

## Findings

### S2-001 [CRITICAL] [PROD-RISK] Le throttle de login n'est branché nulle part dans le gateway

- **Flow** : login (brute-force protection)
- **Localisation** :
  - `packages/auth/src/throttle.ts:188` — `shouldAllowLogin()` est exporté et entièrement testé
  - `packages/auth/src/service.ts:629-657` — `login()` accepte `options.throttle: LoginThrottleDecision`
  - `packages/api/src/adapters/auth-deps.ts:243-247` — appel `svcLogin(input, state.serviceDeps)` **sans `options`**
  - `packages/api/src/routes/auth.ts:140-150` — handler `POST /login` : aucune dérivation IP, aucun appel `shouldAllowLogin`
- **Description** : `shouldAllowLogin(ip, email, deps)` est implémenté en sliding-window 5 / 900 s, testé (`packages/auth/src/__tests__/throttle.test.ts`), et le service `login` est prêt à le consommer via `LoginOptions.throttle`. Mais le pont entre le router HTTP et la primitive n'a jamais été posé : le router ne lit pas `CF-Connecting-IP`, ne construit pas la décision, et `buildAuthDeps.login` appelle `svcLogin` sans `options.throttle`. `grep -r 'shouldAllowLogin' packages/api/src` ne renvoie **aucun** résultat.
- **Scénario d'attaque** : un attaquant lance 10 000 requêtes/s sur `POST /v1/auth/login` avec un dictionnaire `(victim@email.com, passwd_N)`. Aucune erreur 429 n'est produite. La seule limite est le coût bcrypt cost 12 (~150 ms × parallélisme du Worker), soit plusieurs milliers de tentatives/min/IP en pratique. Combiné à S2-003 (rate-limit global non monté), il n'y a **aucun** rempart.
- **Impact** : credential stuffing trivial sur tout compte du tenant ; coût opérationnel CPU/Worker élevé ; la Req 1.6 (« HTTP 429 si plus de 5 tentatives en 15 min ») est **non satisfaite en production**.
- **Mitigation recommandée** :
  1. Dans `routes/auth.ts`, lire `CF-Connecting-IP` ou `X-Forwarded-For[0]`, appeler `shouldAllowLogin` avant `deps.login(input)`, et propager la décision via une nouvelle méthode `AuthDeps.loginWithThrottle(ip, input)` ou en injectant un `LoginOptions` côté `buildAuthDeps`.
  2. Au minimum, monter le `rateLimit()` middleware (cf. S2-003) sur `/v1/auth/login` avec un budget plus serré (ex. 10 / min / IP).
- **Effort** : small (1-2 h, le code existe déjà côté `@athlya/auth`).

---

### S2-002 [CRITICAL] [PROD-RISK] La rotation de refresh token n'est pas atomique → race conditional fork de session

- **Flow** : refresh
- **Localisation** : `packages/api/src/adapters/auth-session-store-redis.ts:67-104`
- **Description** : la méthode `rotate(oldSid, newSid, newExpiresAt)` est explicitement documentée comme « NOT atomic across the two deletes + two writes » (commentaire ligne 20). Elle exécute en 5 round-trips HTTP Upstash distincts :
  1. `GET auth:sid:<oldSid>` (lecture)
  2. `SET auth:sid:<newSid>` (écriture du nouveau)
  3. `SADD auth:user:<userId>:sids newSid`
  4. `DEL auth:sid:<oldSid>` (invalidation)
  5. `SREM auth:user:<userId>:sids oldSid`

  Entre les étapes 1 et 4, un attaquant qui possède le même refresh token (vol/rejeu) peut frapper l'endpoint `/v1/auth/refresh` en parallèle d'une rotation légitime. Les deux requêtes passent toutes les deux le `GET` (étape 1) avec la même valeur, créent toutes les deux un nouveau sid (étape 2 différent grâce à `crypto.randomUUID()`), puis chacune supprime le même `oldSid` (étape 4 — idempotent). **Résultat : deux chaînes de refresh divergentes vivent en parallèle**, chacune liée au même userId. Le contrat `rotate()` censé renvoyer `false` pour la deuxième rotation est violé.

- **Scénario d'attaque** : attaquant intercepte un refresh token (XSS, log fuite, malware sur device). Au moment où la victime fait `refresh`, l'attaquant envoie aussi son `refresh` exactement en parallèle. Les deux gagnent ; l'attaquant possède désormais une chaîne de refresh persistante indépendante de celle de la victime.
- **Impact** : compromission persistante invisible côté victime (sa chaîne fonctionne toujours), aucun signal d'alerte. Couplé à S2-004 (pas de family-tree revoke), il n'y a **aucune détection** possible a posteriori.
- **Mitigation recommandée** :
  - Remplacer la séquence par un script Lua Upstash (`EVAL`) qui fait dans une transaction unique : `GETDEL <oldKey>` + `SET NX <newKey>` + mises à jour du SET d'index. `GETDEL` (Redis 6.2+) est atomique.
  - Alternative : utiliser `SET <newKey> ... NX` puis `DEL <oldKey>` ; faire la lecture du payload via `GETDEL <oldKey>`. Si `GETDEL` retourne `nil`, la rotation a déjà eu lieu → renvoyer `false`.
- **Effort** : medium (1 journée incluant test de race avec `Promise.all`).

---

### S2-003 [CRITICAL] [PROD-RISK] Le middleware de rate-limit global n'est pas monté dans le worker

- **Flow** : rate-limit (Req 14.3 IP 100 rps, Req 14.4 user 500 rps)
- **Localisation** :
  - `packages/api/src/middleware/rate-limit.ts:165-243` — `rateLimit()` factory complet et testé
  - `packages/api/src/worker.ts` — **aucun** appel `app.use('*', rateLimit(...))`. Confirmation : `grep 'rateLimit' packages/api/src/worker.ts` → 0 résultat.
  - Seuls les tests d'intégration (`integration-helpers.ts:582`) montent le middleware ; en production il n'est jamais activé.
- **Description** : la primitive sliding-window-Redis et son middleware Hono sont implémentés et testés ; ils ne sont simplement pas câblés sur le `app` retourné par `buildApp()`.
- **Scénario d'attaque** : flood HTTP de n'importe quel endpoint `/v1/*`, y compris `/v1/auth/refresh` et `/v1/auth/login`. Pas de 429, pas de `Retry-After`. Couplé à S2-001 et S2-002, l'attaquant a un terrain de jeu illimité.
- **Impact** : DoS endogène sur Worker quota, brute-force gratuit, exhaustion bcrypt CPU.
- **Mitigation recommandée** : ajouter dans `buildApp()` après le bloc CORS / tracing :
  ```ts
  app.use('/v1/*', rateLimit());
  ```
  Et un seuil plus strict spécifique pour `/v1/auth/*` (ex. `app.use('/v1/auth/*', rateLimit({ ipLimit: 20, windowSec: 60 }))`).
- **Effort** : trivial (3-5 lignes + 1 test d'intégration).

---

### S2-004 [HIGH] [PROD-RISK] Pas de revoke « family tree » sur réutilisation de refresh token

- **Flow** : refresh
- **Localisation** :
  - `packages/auth/src/service.ts:818-863` — `refresh()` rejette `token_invalid` quand `rotate()` retourne `false`, mais **ne révoque pas** la chaîne descendante.
  - `packages/api/src/adapters/auth-session-store-redis.ts` — pas de structure « family » côté Redis.
  - `tasks.md:786` — explicitement listé comme TODO B3.2 : « tracer dans Redis `auth:family:<rootSid>` la chaîne de rotations. Si un sid déjà rotaté est re-présenté → revoke toute la family + alert ».
- **Description** : la détection « refresh-reuse » (signe quasi-certain de vol de token) ne déclenche actuellement qu'un `401 token_invalid` sur la requête fautive. La nouvelle chaîne légitime (rotated) reste valide. Il n'y a aucun audit log spécifique (`token.refresh.reuse.detected` est mentionné en commentaire mais pas écrit).
- **Scénario d'attaque** : attaquant vole un refresh token (XSS, exfiltration MMKV, log de proxy). Quand la victime utilise son refresh, attaquant tente le sien → `401`, et la victime continue normalement. Plus tard, attaquant intercepte un autre refresh dans la chaîne et peut indéfiniment rester actif tant qu'il bat la victime à l'appel `refresh`.
- **Impact** : compromission persistante non détectable, pas de mécanisme « kick out » sur soupçon.
- **Mitigation recommandée** :
  1. Ajouter un champ `rootSid` dans le payload Redis ; lors du rotate, propager `rootSid` du parent au nouveau sid.
  2. Sur `rotate(oldSid, ...) → false` ET si `oldSid` a un `rotatedAt` non-null (déjà rotaté, pas juste expiré), faire `revokeAllForUser(userId)` ou mieux, `revokeFamilyByRootSid(rootSid)` + écrire un audit `token.refresh.reuse.detected` + publier `auth.suspicious.refresh.reuse` event.
  3. Idéalement, fournir un endpoint `POST /v1/auth/logout-all` (TODO B3.3) pour permettre à l'utilisateur de couper toutes ses sessions depuis une notification.
- **Effort** : medium (2-3 jours, schéma Redis + service + tests).
- **Statut (2026-10-18, issue #631)** : résolu dans le code. B3.2 est livré (Sprint 2 / Vague 29) : index Redis `auth:family:<rootSid>` + `auth:sid_to_root:<sid>`, `SessionStore.revokeFamilyByRootSid` (`packages/api/src/adapters/auth-session-store-redis.ts`), et `refresh()` (`packages/auth/src/service.ts`) révoque toute la family sur réutilisation, écrit l'audit `token.refresh.reuse.detected` et publie `auth.suspicious.refresh.reuse`. B3.3 (`POST /v1/auth/logout-all`) est livré, voir S2-010. Le texte ci-dessus est conservé tel quel (état au 2026-05-15).

---

### S2-005 [HIGH] [PROD-RISK] Validation `iss` / `aud` non configurée — JWT cross-issuer accepté

- **Flow** : JWT verification (gateway + service refresh)
- **Localisation** :
  - `packages/api/src/middleware/auth.ts:319-331` — `JwtAuthOptions.issuer/audience` sont **optionnels**.
  - `packages/api/src/routes/*.ts` — chaque appel `jwtAuth()` passe `{}` (aucune option). Confirmation : `grep -r 'jwtAuth(' packages/api/src/routes` → tous appellent `jwtAuth()` sans arguments.
  - `packages/api/src/adapters/auth-deps.ts:160-200` — `serviceDeps` n'expose pas `options.jwtIssuer` / `options.jwtAudience`. `grep -E 'jwtIssuer|jwtAudience' packages/api/src/adapters/auth-deps.ts` → 0 résultat.
  - `packages/auth/src/service.ts:855-867` — `refresh()` propage `deps.options.jwtIssuer/jwtAudience` mais ils ne sont jamais peuplés en prod.
- **Description** : `jose.jwtVerify` n'effectue le contrôle `iss` / `aud` que lorsque l'option correspondante est fournie. Sans config, **n'importe quel JWT signé par une clé du JWKS** est accepté, même s'il n'a pas été émis pour Athlya. Le JWKS est local et l'algo est pinned RS256, donc le risque effectif est limité à un attaquant qui aurait accès à la clé privée Athlya — auquel cas tout est compromis. Mais en posture défense en profondeur, l'absence de `iss/aud` empêche aussi de :
  - segmenter dev vs staging vs production (un token staging fonctionnerait en prod si le JWKS prod contient encore l'ancien `kid`),
  - distinguer access vs refresh tokens par audience (les deux sont actuellement signés par la même `signingKey` sans champ `aud`).
- **Scénario d'attaque** : promotion d'un access token volé en staging (où la sécurité est moindre) vers prod si la même `signingKey` y est encore active pendant la fenêtre de rotation (24 h documentée).
- **Impact** : violation Req 14.1 (vérification stricte de l'`iss`) et bonne pratique RFC 8725 §3.2.
- **Mitigation recommandée** :
  - Définir `JWT_ISSUER='https://auth.athlya.app'` et `JWT_AUDIENCE='athlya-api'` dans `wrangler.toml` (par environnement).
  - Passer `{ issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE }` à chaque `jwtAuth()` et à `AuthServiceDeps.options`.
  - Ajouter un test de régression qui rejette un token sans `iss`.
- **Effort** : small (4 h).

---

### S2-006 [HIGH] [PROD-RISK] Aucun flow `password reset` / `forgot password`

- **Flow** : récupération de compte
- **Localisation** : néant. `grep -rE 'password.reset|forgot.password|resetPassword'` ne renvoie aucune route, aucun service, aucun token de reset.
- **Description** : il n'existe aucun moyen pour un utilisateur de récupérer son compte s'il oublie son mot de passe. Combiné à HIBP fail-closed (S2-009) qui empêche la réutilisation d'anciens mots de passe leakés, un utilisateur dont le password est désormais dans HIBP est définitivement bloqué.
- **Scénario** : utilisateur oublie son mot de passe → contact support (qui n'a aucun outil pour reset), ou abandon. Surface de support et churn élevés.
- **Impact** : non bloquant techniquement, mais bloquant fonctionnellement avant prod.
- **Mitigation recommandée** : implémenter le flow standard :
  1. `POST /v1/auth/forgot-password { email }` → toujours 202 (pas d'enumération) ; emit event `auth.password.reset.requested` qui déclenche email avec token signé court (15 min, JWT à part avec `aud=password_reset`).
  2. `POST /v1/auth/reset-password { token, newPassword }` : vérifie token, vérifie HIBP, hash, update, **revokeAllForUser**, audit log.
  3. Throttle 3 req / 15 min / email pour éviter le spam.
  4. Token single-use via Redis `auth:reset:<jti>` avec TTL=15 min.
- **Effort** : large (3-5 jours incluant tests + email template + i18n).

---

### S2-007 [HIGH] [PROD-RISK] Tenant resolver implémenté mais non monté

- **Flow** : multi-tenant isolation
- **Localisation** :
  - `packages/api/src/middleware/tenant-resolver.ts:331+` — `resolveTenant()` complet, testé (`tenant-resolver.test.ts`).
  - `packages/api/src/worker.ts` — `grep 'tenantResolver|tenant-resolver|resolveTenant' packages/api/src/worker.ts` → 0 résultat.
- **Description** : la résolution tenant via `Host: <slug>.athlya.app` ou `/s/<slug>/...` n'est appliquée nulle part. Le tenant est uniquement déterminé par le claim `studio` du JWT. Cela fonctionne pour l'API mobile (header-based) mais expose les apps web/studio à un risque de confusion : un attaquant peut atteindre `acme.athlya.app/v1/...` avec un JWT pour `beta.athlya.app` et le serveur ne détecte pas la mismatch host vs claim.
- **Scénario d'attaque** : phishing — l'attaquant fait suivre un lien `acme.athlya.app/dashboard` à une victime du tenant `beta`. Le navigateur envoie le bearer token de `beta` (selon SameSite/scope du cookie de refresh). Le gateway accepte. La page semble appartenir au studio `acme` mais charge des données du studio `beta`. Confusion d'UI possible.
- **Impact** : risque social engineering / branding mismatch ; pas de fuite de données cross-tenant directe (les requêtes downstream filtrent toujours par `claims.studioId`).
- **Mitigation recommandée** :
  - Monter `app.use('*', tenantResolverMiddleware())` dans `worker.ts` avant `mountDomainRoutes`.
  - Si le résultat est `'subdomain' | 'path'` et qu'un JWT est présent, comparer `slug` au `studio` du claim (lookup via `findStudioById`) ; mismatch → 404 Problem Details.
- **Effort** : medium (1 jour, le middleware existe déjà).

---

### S2-008 [HIGH] [PROD-RISK] `/v1/auth/refresh` ne porte aucune protection contre l'abus

- **Flow** : refresh
- **Localisation** : `packages/api/src/routes/auth.ts:155-164`
- **Description** : la chaîne pour `POST /refresh` est : `zValidator(RefreshRequestSchema) → handler`. Pas de Turnstile, pas de rate-limit (cf. S2-003 le global n'est pas monté), pas d'idempotence (volontairement, pour préserver la rotation single-use), pas de throttle par-IP.
- **Scénario d'attaque** : couplé à S2-002 (rotate non-atomique), un attaquant qui vole un refresh peut spammer `/refresh` à très haut débit pour gagner toutes les races contre la victime.
- **Impact** : amplification de S2-002.
- **Mitigation recommandée** : monter un rate-limit dédié `app.use('/v1/auth/refresh', rateLimit({ ipLimit: 30, windowSec: 60 }))` ; le coût d'un refresh légitime est très faible donc une limite stricte n'impacte pas l'UX.
- **Effort** : trivial.

---

### S2-009 [MEDIUM] [PROD-RISK] HIBP fail-closed bloque toute inscription si HIBP tombe

- **Flow** : register
- **Localisation** : `packages/auth/src/service.ts:526-547`
- **Description** : choix volontaire et documenté — toute indisponibilité HIBP renvoie `password_breached` à l'utilisateur. C'est sûr mais brutal : une panne HIBP = zéro nouvelle inscription jusqu'à résolution. L'erreur surface est de plus trompeuse (l'utilisateur croit son mot de passe fuité).
- **Scénario** : panne HIBP de quelques heures (déjà arrivé). Onboarding stoppé, support submergé.
- **Impact** : perte d'inscription pendant la panne, confusion utilisateur.
- **Mitigation recommandée** :
  - Conserver fail-closed mais retourner un code distinct `hibp_unavailable` (HTTP 503) pour que l'UI affiche « notre service de vérification est temporairement indisponible, réessayez dans quelques minutes » plutôt que « votre mot de passe est compromis ».
  - Optionnellement, après N tentatives infructueuses sur même IP, basculer en cache local des hashes HIBP (top 1M) chargé via R2 pour continuer à servir.
- **Effort** : small (2 h pour le code distinct).

---

### S2-010 [MEDIUM] [PROD-RISK] Logout révoque TOUS les refresh tokens du user, pas seulement le sid courant

- **Flow** : logout
- **Localisation** : `packages/api/src/adapters/auth-deps.ts:271-282`
- **Description** : le router appelle `deps.logout(userId)` (pas le refresh token), et l'adapter fait `sessionStore.revokeAllForUser(userId)`. Comportement plus strict que ce que le service `@athlya/auth` propose (`logout(refreshToken)` qui ne revoke qu'un sid). Conséquence : se déconnecter sur le téléphone déconnecte le navigateur web, le studio admin, et toute autre session active.
- **Scénario** : utilisateur fait logout sur mobile pour passer son téléphone à un proche. Son ordinateur de bureau est aussi déconnecté → friction.
- **Impact** : UX dégradée ; pas un vrai risque sécurité mais comportement non-conforme aux attentes utilisateur (la plupart des SaaS proposent « logout this device » et « logout all devices » distincts).
- **Mitigation recommandée** :
  - Soit lire le refresh-cookie côté gateway et appeler `svcLogout(refreshToken)` pour ne révoquer qu'un sid.
  - Soit ajouter un endpoint dédié `POST /v1/auth/logout-all` (TODO B3.3) en gardant `/v1/auth/logout` sur le sid courant.
- **Effort** : small.
- **Status (2026-10-19, issue #674)**: resolved. `POST /v1/auth/logout` now takes an optional `{ "refreshToken" }` body and revokes only that token's session through `logout(refreshToken, deps, { userId })` (`packages/auth/src/service.ts`, called from `packages/api/src/adapters/auth-deps.ts`); a refresh token of another user is rejected with `token_invalid`. The user's other sessions stay live, and the rotation family / `sid_to_root` entries are kept so reuse detection still works. The web and studio `/api/auth/logout` proxies forward their refresh cookie and the mobile app sends its stored refresh token. A request without a refresh token (mobile builds that predate the change) still revokes every session, so no client is left with a live refresh token after sign-out. `POST /v1/auth/logout-all` (B3.3, Sprint 4 / Vague 32) remains the "sign out everywhere" path. Previous status (2026-10-18, issue #631): partially resolved, `/logout` still revoked every session. The text above is kept as is (state on 2026-05-15).

---

### S2-011 [MEDIUM] [PROD-RISK] OAuth verifier accepte ES256 ET RS256 — élargit la surface algo

- **Flow** : login Apple / Google (actuellement retiré, voir slice B8.4)
- **Localisation** : `packages/auth/src/service.ts:728` — `algorithms: ['RS256', 'ES256']`
- **Description** : pour les ID tokens externes, deux algos sont autorisés. Apple utilise actuellement RS256, Google supporte les deux mais publie surtout RS256 dans le JWKS. L'autorisation conjointe ouvre une surface de confusion algorithmique en théorie : si un `kid` du JWKS Apple/Google est marqué pour ES256 et un autre pour RS256, jose pourrait accepter un token signé avec l'autre algo si le verifier match l'algo de la clé. En pratique jose v6 lie l'algo à la clé via le JWKS, donc le risque est faible.
- **Note** : Les routes `/v1/auth/login-with-apple|google` ont été **retirées** en slice B8.4 (cf. `routes/auth.ts:35-44`), donc cette finding est actuellement non-exploitable. À garder en tête lors de la réintroduction.
- **Scénario** : Apple change son algo de signature → confusion temporaire pendant la rotation. Faible probabilité.
- **Impact** : potentiel acceptance de token forgé si un futur attaquant trouve une faiblesse dans l'un des deux algos.
- **Mitigation recommandée** : pinner un algo par provider (`apple → RS256`, `google → RS256`) lors de la réintroduction OAuth.
- **Effort** : trivial.

---

### S2-012 [MEDIUM] [PROD-RISK] Endpoint `/v1/auth/refresh` retourne le refreshToken en clair dans le JSON body

- **Flow** : session lifecycle (cookie security)
- **Localisation** : `packages/api/src/adapters/auth-deps.ts:200-208`, `packages/shared/src/schemas/api.ts:183-189`
- **Description** : `SessionResponseSchema` impose `refreshToken: z.string()` dans le corps de réponse. Le wrapper Next.js `apps/web/src/app/api/auth/refresh/route.ts` strippe ce champ et le repose dans le cookie HttpOnly avant de renvoyer au navigateur. **Mais** :
  - Tous les clients qui parlent directement à l'API (mobile React Native, scripts d'intégration, mauvaises implémentations de proxy front) reçoivent le refreshToken en clair.
  - Si l'API est appelée depuis un environnement avec extensions de navigateur, malware, ou logging proxy mal configuré, le refresh token fuite via les logs.
  - L'attribut `Secure` sur le cookie protège HTTPS-only ; rien ne protège le body JSON HTTPS du fait qu'il soit lu/loggué par un middleware.
- **Scénario** : log applicatif Sentry capture une erreur sérialisant la response → fuite du refreshToken dans Sentry.
- **Impact** : exposition accrue des tokens à long-TTL dans les logs.
- **Mitigation recommandée** :
  - Côté API gateway, supporter une option `Set-Cookie` directe (`refreshToken` en cookie HttpOnly + `accessToken` en JSON) lorsque `Origin` est un domaine athlya web — économise un hop côté Next.js.
  - Ajouter un Sentry beforeSend qui scrubt les champs `refreshToken` / `accessToken` des breadcrumbs.
  - Documenter clairement que les clients NON-web doivent stocker le refresh dans le keychain OS et jamais en JS-accessible.
- **Effort** : medium.

---

### S2-013 [MEDIUM] [DEV-ONLY] Turnstile bypassé silencieusement en `dev` si secret absent

- **Flow** : turnstile (anti-bot)
- **Localisation** : `packages/api/src/middleware/turnstile.ts:382-389`
- **Description** : si `c.env.ENVIRONMENT === 'dev'` et `TURNSTILE_SECRET` est manquant/vide, le middleware émet un `warn` puis appelle `next()`. C'est intentionnel pour la productivité dev, mais le warn est noyé dans des logs JSON et facile à oublier. Risque : un dev qui copie sa config locale en staging laisse `TURNSTILE_SECRET=''` et perd la protection.
- **Scénario** : régression d'env entre dev et staging.
- **Impact** : minimal en pratique car staging contrôle ENVIRONMENT='staging' qui force `500 configuration_error`. **Mais** si un opérateur configure `ENVIRONMENT='dev'` accidentellement en staging/prod, Turnstile est bypassé.
- **Mitigation recommandée** :
  - Refuser le boot du Worker si `ENVIRONMENT='dev'` ET host n'est pas `localhost|127.0.0.1|*.local`.
  - Ou retirer entièrement le bypass et exiger un secret « dev » bidon (`1x0000000000000000000000000000000AA` est le test secret officiel CF).
- **Effort** : trivial.

---

### S2-014 [LOW] [PROD-RISK] `clockTolerance: 0` en production — sensible aux dérives NTP cross-région

- **Flow** : JWT verification (access + refresh + QR)
- **Localisation** :
  - `packages/api/src/middleware/auth.ts:328` — défaut 0
  - `packages/auth/src/jwt.ts:319` — défaut 0
  - `packages/auth/src/qr.ts:285` — `0` explicite
  - `docs/frameworks/jose.md:99` — choix documenté
- **Description** : zéro tolérance signifie qu'un client dont l'horloge dérive de quelques secondes vers le futur (cas connu sur certains Android/iOS au sortir du mode avion) verra ses tokens fraîchement émis rejetés avec `iat in future`. La doc cite « les Workers et clients sont NTP-synced » — vrai pour le Worker, **faux côté client mobile** où la dérive peut atteindre 60 s.
- **Scénario** : utilisateur en avion pendant 8 h, allume mobile → tokens minté avec horloge -3 min → `nbf/iat` future relative au serveur → 401 invalid_token.
- **Impact** : faux-positifs UX, support tickets « ma session ne marche pas ».
- **Mitigation recommandée** : passer à `clockToleranceSec: 5` côté `jwtAuth` (gateway), garder `0` pour les QR (fenêtre 120 s, 5 s de tolérance casserait la garantie).
- **Effort** : trivial.

---

### S2-015 [LOW] [PROD-RISK] JWKS cache 10 min — fenêtre où un kid révoqué reste accepté

- **Flow** : JWT verification + key rotation
- **Localisation** : `packages/api/src/middleware/auth.ts:142-151`
- **Description** : `createRemoteJWKSet` est configuré avec `cacheMaxAge=600000ms` (10 min). Pendant cette fenêtre, si un `kid` est retiré du JWKS suite à une rotation d'urgence (clé compromise), l'ancien `kid` reste accepté par chaque Worker isolate ayant chargé le JWKS récemment. Couplé à la fenêtre de grâce de 24 h documentée dans `jwt.ts`, une compromission de clé reste exploitable jusqu'à `min(grace, 10 min) + 10 min`.
- **Scénario** : compromission de la clé privée. Ops fait `rotateKeys` immédiatement et retire le kid compromis du JWKS publié. Les Workers continuent à accepter pendant ~10 min.
- **Impact** : MTTR de 10 min au lieu de quelques secondes en cas de compromission active.
- **Mitigation recommandée** :
  - Réduire à `cacheMaxAge=60_000` (1 min) — coût négligeable (1 fetch/min/isolate).
  - Implémenter un endpoint `POST /v1/admin/jwt/invalidate-cache` admin-only qui clear `jwksGetters` (la fonction `__resetJwksCacheForTests` existe déjà).
- **Effort** : trivial pour la première option.

---

### S2-016 [LOW] [DEV-ONLY] Timing oracle via durée HIBP en register

- **Flow** : register
- **Localisation** : `packages/auth/src/service.ts:526-555`
- **Description** : la phase HIBP (~150-300 ms réseau) précède le bcrypt (~150 ms CPU). Un attaquant qui mesure le temps de réponse de `/register` peut distinguer :
  - réponse rapide (~5 ms) → studio_not_found (avant HIBP)
  - réponse moyenne (~200 ms) → password_breached (HIBP a répondu et a hit)
  - réponse longue (~400 ms) → email_taken (HIBP + bcrypt + insert)
- **Scénario** : énumération de slugs / passwords courants via timing.
- **Impact** : faible — l'enumération de slugs est déjà partiellement publique (URLs) ; password breached n'identifie pas un compte existant.
- **Mitigation recommandée** : exécuter HIBP et bcrypt en parallèle (`Promise.all`) puis brancher selon les résultats — le coût total est `max(HIBP, bcrypt)` au lieu de la somme.
- **Effort** : small.

---

### S2-017 [LOW] [DEV-ONLY] `decodeUnsafeRefresh` fait confiance à un payload non signé

- **Flow** : logout
- **Localisation** : `packages/auth/src/service.ts:991-1014`
- **Description** : sur logout d'un token expiré, le service décode le payload sans vérifier la signature pour récupérer le `sid` et le retirer du store. C'est documenté comme « courtesy cleanup ». Un attaquant peut forger un faux `refreshToken` avec n'importe quel sid existant (devinable s'il connaît un userId via l'API d'autre tenant) et appeler `/logout` pour faire un DoS de session ciblé.
- **Scénario** : attaquant énumère des sids → DoS de sessions.
- **Impact** : très faible — les sids sont des UUID v4 (128 bits) non énumérables ; il faudrait connaître le sid exact, ce qui implique déjà compromission.
- **Mitigation recommandée** : aucune action — le risque est quasi-nul. Garder la logique pour idempotence.
- **Effort** : —

---

### S2-018 [INFO] [DEV-ONLY] Le DLQ admin router (`/admin/dlq/*`) n'est pas monté dans le worker

- **Flow** : RBAC admin
- **Localisation** : `packages/api/src/admin/dlq-routes.ts:196` (factory) ; `worker.ts` (pas de `app.route('/admin', buildDlqRouter())`)
- **Description** : le router DLQ admin est correctement protégé par `enforceAdmin` mais n'est mounté nulle part dans `buildApp`. Tous les tests passent par un app jetable. Conséquence : pas de risque RBAC actuel, mais la fonctionnalité ops promise dans `README.md` n'est pas livrée.
- **Impact** : aucun risque sécurité, gap fonctionnel ops.
- **Mitigation recommandée** : `app.route('/', buildDlqRouter())` dans `buildApp()`, derrière `jwtAuth()`.
- **Effort** : trivial.

---

### S2-019 [INFO] [DEV-ONLY] `cancelReservation` n'est pas encore wiré

- **Flow** : reservations RBAC
- **Localisation** : `packages/api/src/routes/index.ts:435-441` — stub `notImplemented('reservations.cancelReservation')`.
- **Description** : ne peut pas vérifier en pratique que le repo filtre par `(userId, reservationId)` et non juste par `id`. Les tests d'intégration le simulent via stub. À surveiller lors du wiring.
- **Mitigation recommandée** : quand le repo Drizzle pour reservations sera livré, vérifier que la WHERE clause inclut `user_id = $userId` (la RLS forcée DB-side est un filet en plus).
- **Effort** : —

---

### S2-020 [INFO] [DEV-ONLY] Le store de session Redis n'utilise pas de pipeline

- **Flow** : performance / atomicité partielle
- **Localisation** : `packages/api/src/adapters/auth-session-store-redis.ts:55-115`
- **Description** : chaque opération `create/rotate/revoke` fait 2-5 round-trips HTTP Upstash sériels. À ~30 ms/RTT eu-west-3, un refresh coûte ~150 ms en latence Redis seule. Pas une faille, mais un point d'optimisation lié à S2-002 (qui exigera de toute façon Lua/pipeline).
- **Mitigation recommandée** : remplacer par un script Lua unique pour `rotate` (résout S2-002 en bonus).

---

## Bonnes pratiques observées

- **Pinning algo strict** : `algorithms: ['RS256']` pour access/refresh internes ; rejette HS256 et `none` (test `auth.test.ts:400-415`).
- **Closed enum sur le claim `role`** (`VALID_ROLES = Set('member','admin','coach')`, middleware ligne 60) — empêche un rôle inconnu de passer pour un rôle privilégié.
- **Posture 404 vs 403** sur cross-tenant (`Req 13.5`) : test `multi-tenant-isolation.integration.test.ts` couvre 6 scénarios. Aucune fuite d'existence.
- **HIBP fail-closed** explicite et documenté ; tests dédiés (`hibp.test.ts:90-105`).
- **Timing-uniforme** sur `login` : bcrypt fictif appliqué même si user manquant / OAuth-only (`service.ts:680-688`). Empêche enumeration via timing.
- **Cookie refresh** : `HttpOnly + Secure(prod) + SameSite=Lax + Path=/`, attributs émis dans le bon ordre (Chromium-friendly), avec test unitaire (`cookies.test.ts:18-46`).
- **Idempotency middleware** : protège la refresh contre un double-click client (mais — voir S2-002 — pas contre un attaquant intentionnel parallèle).
- **JWKS local pour le refresh path** (`createLocalJWKSet`) — pas de I/O réseau sur la rotation, immune aux pannes JWKS endpoint.
- **Décodage de payload séparé du verify** : `decodeUnsafeRefresh` est explicitement marqué « UNSAFE » et n'est utilisé que pour le cleanup courtesy.
- **Tests d'isolation tenant** : couvrent listClasses, getMe, updateClass, cancelReservation, listMembersByStudio (rôle guard).
- **Ne pas surfacer les jose error codes** dans les 401 (`auth.ts:412-419`) — anti-fingerprinting.
- **Pas de Bearer error="missing_authorization"`** sur la 401 missing — distinction claire avec `token_expired` (RFC 6750-friendly).
- **Strict mode sur les schémas Zod** (`.strict()` partout) — rejette les champs inattendus, anti-mass-assignment.

---

## Score sécurité : 58 / 100

| Critère                                              | Pondération | Score   | Pondéré |
| ---------------------------------------------------- | ----------- | ------- | ------- |
| Cryptographie & JWT (algo, kid, JWKS)                | 15          | 12 / 15 | 12      |
| Brute-force & rate-limiting (login, refresh, global) | 20          | 5 / 20  | 5       |
| Refresh rotation atomicity & detection               | 15          | 5 / 15  | 5       |
| RBAC (closed enum, requireRole coverage)             | 10          | 9 / 10  | 9       |
| Multi-tenant isolation (404 not 403, RLS)            | 10          | 8 / 10  | 8       |
| Password lifecycle (HIBP, bcrypt, reset)             | 10          | 5 / 10  | 5       |
| Turnstile & anti-bot                                 | 5           | 4 / 5   | 4       |
| Session security (cookies, logout)                   | 5           | 4 / 5   | 4       |
| Audit & observability (logs, traceId, Sentry)        | 5           | 3 / 5   | 3       |
| Tests & defense-in-depth                             | 5           | 3 / 5   | 3       |
| **Total**                                            | **100**     |         | **58**  |

Le score est tiré vers le bas par 3 défauts de **wiring** plutôt que par des défauts de **conception**. Les primitives sont bonnes ; les ponts entre elles manquent.

---

## 3 priorités absolues

### Priorité 1 — Brancher les remparts brute-force (CRITICAL)

- **Combine** : S2-001 + S2-003 + S2-008.
- **Action** :
  1. `app.use('/v1/*', rateLimit())` dans `worker.ts`.
  2. `app.use('/v1/auth/*', rateLimit({ ipLimit: 20, windowSec: 60 }))` (override plus strict).
  3. Dans `auth-deps.ts` ou directement dans `routes/auth.ts`, lire `CF-Connecting-IP`, appeler `shouldAllowLogin`, et propager via `LoginOptions.throttle`.
- **Effort** : 1 journée incluant tests d'intégration.
- **Bénéfice** : ferme le gros trou d'attaque le plus exploitable.

### Priorité 2 — Rendre la rotation refresh atomique + family-tree revoke (CRITICAL + HIGH)

- **Combine** : S2-002 + S2-004 + S2-020.
- **Action** :
  1. Réécrire `SessionStore.rotate` en script Lua (`EVAL`) qui fait `GETDEL` du oldSid + `SET NX` du newSid + mises à jour SET.
  2. Ajouter `rootSid` au payload Redis ; lors de `rotate(oldSid)→false` ET si oldSid était déjà rotaté (présence d'une trace `family:<rootSid>`), appeler `revokeAllForUser` + audit `token.refresh.reuse.detected` + publier event `auth.suspicious.refresh.reuse`.
  3. Ajouter test : `Promise.all([refresh(t), refresh(t)])` doit produire exactement 1 succès et 1 échec.
- **Effort** : 2-3 jours.
- **Bénéfice** : élimine la fenêtre de fork de session et donne un signal d'alerte sur token volé.

### Priorité 3 — Implémenter le password reset flow (HIGH)

- **Action** : S2-006 in extenso (forgot + reset + audit + throttle + email).
- **Effort** : 3-5 jours.
- **Bénéfice** : pré-requis bloquant avant ouverture publique. Empêche le scénario « utilisateur HIBP-leaked, plus aucun moyen de récupérer son compte ».

---

## Annexe — Recommandations secondaires consolidées

À traiter lors du sprint hardening, par ordre d'effort croissant :

1. Configurer `iss` / `aud` (S2-005) — 4 h.
2. Réduire JWKS cache à 60 s (S2-015) — 5 min.
3. Augmenter clockTolerance access à 5 s (S2-014) — 5 min.
4. Exécuter HIBP + bcrypt en parallèle dans register (S2-016) — 1 h.
5. Distinguer `hibp_unavailable` de `password_breached` (S2-009) — 2 h.
6. Refus du boot worker si `ENVIRONMENT='dev'` hors localhost (S2-013) — 1 h.
7. Ajouter `POST /v1/auth/logout-all` + revoir `logout` pour ne couper que le sid courant (S2-010) — 4 h.
8. Pinner `RS256` only sur OAuth lors de la réintroduction (S2-011) — 5 min.
9. Mounter le DLQ admin router (S2-018) — 30 min.
10. Mounter le tenant resolver + cross-check host vs claim (S2-007) — 1 jour.
11. Sentry beforeSend qui scrubt refreshToken (S2-012) — 1 h.

---

_Audit produit le 2026-05-15 — revue de code statique uniquement, aucune modification appliquée. Document destiné à `docs/security/audit-S2-auth.md`._
