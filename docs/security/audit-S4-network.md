# Audit Sécurité S4 — Network, transport & DDoS resilience

Date : 2026-05-15
Auditeur : agent S4 (audit only, lecture seule)
Périmètre : `apps/web`, `apps/studio`, `packages/api`, `packages/auth`, `packages/ratelimit`, configuration Cloudflare (Wrangler).

---

## Posture transport

### TLS

- TLS terminé par Cloudflare en bordure (zone `athlya.app`). La doc inline de `packages/api/src/middleware/security-headers.ts` (Req 25.1) indique explicitement que la version minimum (TLS 1.3) est configurée _côté dashboard Cloudflare_, pas dans le Worker.
- **Géré par Cloudflare automatiquement** (non compté comme finding) : TLS 1.3, OCSP stapling, ALPN/HTTP-2, HTTP-3.
- Aucune configuration TLS côté Workers (impossible : la TLS n'est pas exposée à l'isolate). Aucun cert pinning côté browser (non applicable). Côté mobile, hors périmètre de cet audit.
- ⚠️ La min-TLS n'est pas asserted via IaC (Terraform/Wrangler). Une régression de la console Cloudflare ne déclencherait aucun test → finding S4-013 (LOW).

### HSTS

- Émis par les deux Next.js (`apps/web/next.config.ts` + `apps/studio/next.config.ts`) :
  `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- Émis par le gateway Hono via `securityHeaders()` (`packages/api/src/middleware/security-headers.ts`) avec exactement la même valeur (constante `DEFAULT_HSTS_MAX_AGE_SECONDS = 63_072_000`).
- max-age = 2 ans, `includeSubDomains`, `preload` → conforme au minimum exigé par hstspreload.org.
- ✅ Le périmètre HSTS couvre les trois origines (web/studio/api). Pas de finding bloquant. Voir cependant S4-009 sur le statut effectif de l'inscription preload list.

### Cookies (refresh token)

| Attribut        | `apps/web` (`athlya.refresh`)                        | `apps/studio` (`athlya.refresh.studio`) |
| --------------- | ---------------------------------------------------- | --------------------------------------- |
| `HttpOnly`      | ✅                                                   | ✅                                      |
| `Secure` (prod) | ✅ (conditionnel sur `NODE_ENV === 'production'`)    | ✅                                      |
| `SameSite`      | `Lax`                                                | `Lax`                                   |
| `Path`          | `/`                                                  | `/`                                     |
| `Domain`        | non défini → host-only (correct)                     | non défini → host-only (correct)        |
| `Max-Age`       | aligné sur `refreshTokenExpiresIn` (30 j par défaut) | idem                                    |

- ✅ Noms cookie distincts entre web et studio → pas de conflit de slot dans le même profil navigateur.
- ✅ Pas d'attribut `Domain` → cookie host-only → un sous-domaine compromis ne peut pas voler le cookie d'un autre. Bon.
- ⚠️ `SameSite=Lax` est protecteur contre CSRF "tagué top-level GET", mais une requête `POST` cross-site standard n'envoie pas le cookie de toute façon. Voir S4-005.
- ❌ `Path=/` au lieu de `Path=/api/auth` : le cookie est envoyé pour TOUTES les routes Next, y compris les Server Actions. Voir S4-006.

### CSP

- Stricte, nonce-based, identique entre web et studio (`apps/web/src/lib/csp.ts` / `apps/studio/src/lib/csp.ts`).
- Pas de `'unsafe-inline'` en prod sur `script-src` ; pas de `'unsafe-eval'` en prod (gardé derrière le flag `dev`).
- `style-src` : `'unsafe-inline'` est utilisé en dev **uniquement** (flag `isDev`), `'nonce-…'` en prod. Correct.
- `connect-src 'self' <apiUrl> https://challenges.cloudflare.com`. **Sentry n'est pas dans la liste** (pas de SDK Sentry côté browser à ce jour, donc pas de bloc actif, mais voir S4-008 si Sentry browser est wireé plus tard).
- `frame-ancestors 'none'` + `X-Frame-Options: DENY` → double protection clickjacking. ✅
- `report-to` + `report-uri` émis si `NEXT_PUBLIC_CSP_REPORT_URI` est défini.
- `'strict-dynamic'` dans `script-src` (bonne pratique CSP3).

### CORS

- Configuré globalement dans `packages/api/src/worker.ts` :

```ts
cors({
  origin: (origin, c) => {
    const env = c.env.ENVIRONMENT;
    if (env === 'dev') return origin ?? '';
    const allowed = (c.env as ...).CORS_ORIGIN;
    if (allowed && origin === allowed) return origin;
    return '';
  },
  allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'cf-turnstile-token'],
  allowMethods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  credentials: true,
  maxAge: 86400,
})
```

- ✅ Pas de wildcard `*`. Origin reflétée seulement si elle matche `CORS_ORIGIN`.
- ✅ `Access-Control-Allow-Credentials: true` couplé à une origin spécifique (pas `*`) → conforme CORS spec.
- ❌ En `ENVIRONMENT === 'dev'`, **toute origin est reflétée verbatim** (`return origin ?? ''`). Combiné à `credentials: true`, cela revient à un `Allow-Origin: <attaquant>` + `Allow-Credentials: true` en dev. C'est `[DEV-ONLY]` mais voir S4-002.
- ❌ `CORS_ORIGIN` n'est pas typé comme champ requis dans `AthlyaBindings` (`(c.env as AthlyaBindings & { CORS_ORIGIN?: string }).CORS_ORIGIN`). Si la secret est oubliée au déploiement prod, **toutes les origins cross-site sont rejetées silencieusement** (`return ''`). C'est fail-closed (bon) mais sans alerte de boot. Voir S4-014.

---

## Résumé exécutif

| Sévérité | Findings |
| -------- | -------- |
| CRITICAL | 2        |
| HIGH     | 4        |
| MEDIUM   | 5        |
| LOW      | 4        |
| INFO     | 2        |

**Score posture transport / DDoS : 68 / 100**

Détail :

- TLS / HSTS / cookies / CSP : 88/100 (très bonne base, quelques détails de durcissement).
- DDoS / amplification applicative : 55/100 (**rate-limit gateway non monté**, throttle login non câblé).
- CORS : 80/100 (politique correcte mais pas validée au boot).
- Headers de sécurité : 92/100 (couverture exhaustive, manque uniquement COOP/COEP/CORP).
- Anti-énumération / disclosure : 78/100 (login OK, register et export laissent fuiter).

---

## Findings

### S4-001 [CRITICAL] [PROD-RISK] Le rate-limit middleware global n'est pas monté sur le Worker en production

- **Catégorie** : DDoS / resource exhaustion
- **Localisation** : `packages/api/src/worker.ts:120-200` (chaîne globale `app.use(...)`)
- **Description** : `packages/api/src/middleware/rate-limit.ts` exporte une factory `rateLimit()` complète (sliding window 100 rps/IP, 500 rps/user, 429 + `Retry-After`). Cette factory n'est appelée **que** dans les helpers de tests (`packages/api/src/__tests__/integration/integration-helpers.ts:582` et `__tests__/helpers/test-app.ts:273`). Recherche exhaustive `app\.use.*rateLimit|use.*rateLimit\(` dans les sources de prod : **0 occurrence**.
  Le `worker.ts` monte uniquement : `securityHeaders`, `cors`, tracing, `tracing()`, serve-log. Pas de rate-limit.
- **Scénario d'attaque** : un client (IP unique, sans Bearer) exécute `for i in {1..1000000}; curl https://api.athlya.app/health`. Aucun limiter n'intervient. Cloudflare's L7 protections (Bot Fight Mode, automatic DDoS) absorbent les attaques volumétriques (~Gbps), mais elles ne ciblent pas spécifiquement les abus applicatifs de bas débit (10-50 rps soutenus). Sur les routes coûteuses (`POST /v1/auth/login` → bcrypt cost 12 ≈ 200ms, `POST /v1/auth/register` → bcrypt + HIBP fetch + DB insert + queue publish), ce débit est suffisant pour saturer le budget CPU 50ms/request × N isolates et faire brûler le quota Workers du compte (et la facture).
- **Impact** :
  - **Wallet-DoS** sur le compte Cloudflare (les Workers facturent à la requête).
  - Saturation Upstash Redis (chaque login fait des SET/GET sur le throttle).
  - Saturation HIBP (chaque register fait un fetch sortant).
  - Req 14.3 (100 rps/IP) et 14.4 (500 rps/user) **non satisfaits en production**.
- **Mitigation** :
  ```ts
  // dans buildApp(), AVANT mountDomainRoutes() :
  app.use(
    '/v1/*',
    rateLimit({
      /* defaults Req 14.3/14.4 */
    }),
  );
  ```
  Idéalement après `jwtAuth` pour que les utilisateurs authentifiés tombent sur leur quota par-user, mais avant le routage métier.
  Compléter avec une règle Cloudflare WAF "rate limit /v1/auth/\* à 30 rps par IP" en defense-in-depth.
- **Effort** : ~30 min (4-5 lignes de code + 1 test d'intégration).

---

### S4-002 [CRITICAL] [PROD-RISK] Le throttle login (Req 1.6, 5 tentatives / 15 min sur `(IP, email)`) n'est pas câblé sur la route `/v1/auth/login`

- **Catégorie** : credential stuffing / DDoS auth
- **Localisation** : `packages/api/src/adapters/auth-deps.ts:259-263` + `packages/api/src/routes/auth.ts:140-149`
- **Description** : `packages/auth/src/throttle.ts` exporte `shouldAllowLogin(ip, email, deps)` qui implémente précisément Req 1.6. La fonction `login(input, deps)` du service auth accepte un argument optionnel `options.throttle: LoginThrottleDecision` (`packages/auth/src/service.ts:629-680`) et rejette `AuthError('rate_limited')` si la décision est `allow: false`. Mais l'adapter `buildAuthDeps()` appelle `svcLogin(input, state.serviceDeps)` **sans** passer `{ throttle: ... }`. Recherche `shouldAllowLogin` côté `packages/api/src/**` : 0 occurrence (uniquement référencée depuis les tests unitaires de `packages/auth`).
- **Scénario d'attaque** : credential stuffing classique. Un attaquant rejoue 100 000 (email, password) connus depuis un breach public sur `POST /v1/auth/login`. Aucun limiter par-(IP, email) ne s'enclenche. La seule barrière est la latence bcrypt (~200ms par tentative) + le rate-limit gateway global (qui n'est pas monté non plus, cf. S4-001).
- **Impact** : Req 1.6 violée. Comptes faibles cassables en quelques heures. Cloudflare Turnstile présent sur `/login` côté gateway atténue mais ne couvre pas un attaquant qui solve les CAPTCHAs (services à $1-2/1000 solves) ou qui exploite des tokens Turnstile valides issus d'un autre formulaire (single-use mais réutilisable dans une fenêtre).
- **Mitigation** :
  ```ts
  // dans buildAuthDeps() :
  async login(input) {
      const ip = /* deriveClientIp depuis le request */;
      const decision = await shouldAllowLogin(ip, input.email, { redis });
      const session = await svcLogin(input, state.serviceDeps, { throttle: decision });
      return toAuthSession(session, now);
  },
  ```
  Mais `buildAuthDeps` n'a pas accès au request → il faut passer l'IP/email au router et appeler `shouldAllowLogin` dans le handler de `/v1/auth/login` avant d'invoquer `deps.login()`. Ou enrichir l'interface `AuthDeps.login(input, ctx)` pour transporter l'IP.
- **Effort** : ~1h (interface change + 2 tests).

---

### S4-003 [HIGH] [DEV-ONLY → escalade PROD-RISK si déployé tel quel] CORS reflète n'importe quelle origin avec `credentials: true` en `ENVIRONMENT === 'dev'`

- **Catégorie** : CORS / CSRF
- **Localisation** : `packages/api/src/worker.ts:135` (`if (env === 'dev') return origin ?? ''`)
- **Description** : la branche dev de la callback CORS fait `return origin ?? ''` — c'est-à-dire que l'`Origin` du caller est reflétée verbatim. Combinée à `credentials: true` plus haut dans le bloc, cela produit pour chaque requête en dev :
  ```
  Access-Control-Allow-Origin: <whatever the attacker sent>
  Access-Control-Allow-Credentials: true
  ```
  C'est exactement la configuration qu'un attaquant cross-site exploite pour lire les réponses authentifiées du gateway si un dev tourne `wrangler dev` avec un cookie session valide et visite un site malveillant.
- **Scénario d'attaque** : un dev a `athlya-api-dev` qui tourne sur `localhost:8787`, est loggué (cookie de refresh sur `localhost:3000`). Il visite `https://evil.example`. La page evil fait `fetch('http://localhost:8787/v1/members/me', { credentials: 'include' })`. Le worker répond `Allow-Origin: https://evil.example`, `Allow-Credentials: true`. La page evil lit la réponse et exfiltre les claims.
- **Impact** : compromission de comptes dev, fuite de données de tests, latéralisation potentielle si les credentials dev sont aussi prod.
- **Mitigation** : restreindre la branche dev à des origins explicites (`['http://localhost:3000','http://localhost:3001']`) :
  ```ts
  const DEV_ORIGINS = new Set(['http://localhost:3000', 'http://localhost:3001']);
  if (env === 'dev') return DEV_ORIGINS.has(origin ?? '') ? origin : '';
  ```
- **Effort** : 5 min.

---

### S4-004 [HIGH] [PROD-RISK] Outbox flooding par utilisateur authentifié — pas de quota par-`studioId` ni par-`userId` sur les events

- **Catégorie** : DDoS / amplification applicative
- **Localisation** : `packages/api/src/events/publish.ts` + `packages/auth/src/service.ts:530-560` (publish post-register), routes booking/cancel.
- **Description** : un utilisateur authentifié peut déclencher des events outbox via plusieurs chemins (`POST /v1/reservations` → `reservation.created`, `DELETE /v1/reservations/:id` → `reservation.cancelled`, `PATCH /v1/members/me/consents` → `consents.updated`, etc.). Chaque event :
  1. insère une ligne dans `outbox` (table Postgres),
  2. publie sur `EVENTS_QUEUE` (Cloudflare Queue, billed à $0.40/M).
     Sans rate-limit gateway (cf. S4-001), un user authentifié peut, dans la limite du quota Cloudflare 500 rps/user (qui n'est pas appliqué en prod), faire grossir la table `outbox` et facturer les Queues à un rythme insoutenable.
- **Scénario d'attaque** : un user créé un script qui appelle `POST /v1/reservations` + `DELETE /v1/reservations/:id` en boucle. Chaque cycle crée 2 events outbox. À 100 rps soutenus pendant 24h → 17 280 000 events outbox. Le drainer cron tourne à 1 batch/min × 100 rows = 144 000 rows/jour drainables. Le retard outbox explose, la Queue déborde → DLQ déborde → consumer downstream crash en cascade.
- **Impact** :
  - Saturation table `outbox` (taille disque Neon).
  - Saturation Queue Cloudflare (facturation).
  - Retard temps-réel sur les notifs cross-tenant (perte de SLA).
- **Mitigation** :
  - Compteur Redis par-user : `outbox:rate:<userId>` avec TTL 1h, max 1000 events/h soft cap.
  - Quota par-tenant via `app.studio_id` (Req 13.1 RLS context).
  - Alerte Axiom sur `outbox.size > 100k` ou drain backlog > 5min.
- **Effort** : 2h (mid).

---

### S4-005 [HIGH] [PROD-RISK] CSRF protection absente sur la route Next.js `/api/auth/refresh` côté web/studio

- **Catégorie** : CSRF
- **Localisation** : `apps/web/src/app/api/auth/refresh/route.ts`, `apps/studio/src/app/api/auth/refresh/route.ts`
- **Description** : la route lit le cookie `athlya.refresh` (HttpOnly, `SameSite=Lax`) et le forward au gateway. `SameSite=Lax` empêche le cookie de partir sur un POST cross-site classique (form submit), mais :
  1. Une page malveillante peut faire un POST same-site si elle est servie depuis un sous-domaine de `athlya.app` compromis ou un assets bucket qui héberge du HTML user-controlled.
  2. Le SameSite Lax laisse passer les top-level navigations en GET → si le refresh route accepte GET (à vérifier), exploitable.
  3. Aucun token CSRF, pas de double-submit cookie, pas de `Origin` check.
- **Scénario d'attaque** : un sous-domaine tenant (`acme.athlya.app`) compromis (XSS dans une page user-content), depuis lequel l'attaquant fait `fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })` côté `app.athlya.app` — le cookie part car même eTLD+1.
- **Impact** : rotation forcée du refresh token + récupération de l'access token ; combiné à un XSS, vol de session.
- **Mitigation** :
  - Vérifier `Origin: https://app.athlya.app` (ou la liste blanche d'origins Next.js).
  - Émettre un `Sec-Fetch-Site` check : `same-origin` requis.
  - Optionnel : token CSRF double-submit dans un cookie `__Host-csrf` (Path=/, Secure, no-Domain).
- **Effort** : 30 min (origin check), 2h (token CSRF).

---

### S4-006 [HIGH] [PROD-RISK] Cookie refresh `Path=/` au lieu de `Path=/api/auth`

- **Catégorie** : Cookie scoping / surface d'attaque
- **Localisation** : `apps/web/src/lib/auth/cookies.ts:42-44`, `apps/studio/src/lib/auth/cookies.ts:35-37`
- **Description** : le cookie `athlya.refresh` est émis avec `Path=/` → il est envoyé sur **toutes** les routes Next, y compris les Server Actions, les pages SSR, les routes statiques générées dynamiquement. Le cookie est `HttpOnly` donc inaccessible à JS, mais le serveur Next le voit dans `request.cookies.get(...)` à chaque requête. Une route handler malicieuse (ex: une lib npm compromise qui ajoute un hook) peut le lire.
- **Scénario d'attaque** : supply-chain (typosquat sur une dep Next), ou prompt injection dans un endpoint LLM qui lit `request.cookies` pour debug et leak via logs.
- **Impact** : surface d'attaque cookie élargie. Defense-in-depth raté.
- **Mitigation** : restreindre à `Path=/api/auth` (toutes les routes auth-handlers vivent sous `/api/auth/*`). Le cookie ne sera transmis qu'aux routes qui en ont besoin.
- **Effort** : 5 min + retests E2E (vérifier que toutes les routes qui lisent le cookie sont bien sous /api/auth).

---

### S4-007 [MEDIUM] [PROD-RISK] Email enumeration sur `POST /v1/auth/register`

- **Catégorie** : information disclosure
- **Localisation** : `packages/auth/src/service.ts:412-490` (register), réponse `email_taken`
- **Description** : `register()` rejette `AuthError('email_taken')` (HTTP 422) quand l'email existe déjà. La réponse révèle l'existence d'un compte. Comparé à `login()` qui maintient un opaque `invalid_credentials` indistinguable, register fuite. Compléments :
  - Timing : le path "email taken" raccourcit (no bcrypt sur reject), donc oracle de timing supplémentaire même si le code était unifié.
  - HIBP fail-closed sur unavailability (bon pour la sécurité mais introduit un oracle indirect : si HIBP est down vs si l'email est taken, le code est différent).
- **Scénario d'attaque** : un attaquant énumère `users@target.com` en faisant des `POST /v1/auth/register` avec un mot de passe valide. Distinguishe `email_taken` (existe) vs `password_breached` (n'existe pas mais HIBP dit weak) vs success (n'existe pas).
- **Impact** : énumération massive de comptes. Combine avec S4-002 pour préparer du credential stuffing ciblé.
- **Mitigation** : retourner toujours 202 Accepted + envoyer un email "your registration is pending" à l'adresse, sans indiquer si elle existe déjà (l'email peut différer selon le cas). Ou unifier la réponse d'erreur : 422 générique sans distinction.
- **Effort** : 1h (refactor + tests).

---

### S4-008 [MEDIUM] [PROD-RISK] `connect-src` CSP n'autorise pas Sentry — bombe à retardement quand Sentry-browser sera wireé

- **Catégorie** : CSP / observabilité
- **Localisation** : `apps/web/src/lib/csp.ts:88`, `apps/studio/src/lib/csp.ts:51`
- **Description** : le script `apps/web/src/app/error.tsx:46-48` mentionne explicitement "Production builds ship a separate observability integration (Sentry via the API gateway)". Aujourd'hui Sentry est server-only (gateway). Quand un task futur ajoute `@sentry/nextjs` côté browser, les ingestions POST vers `*.ingest.sentry.io` seront bloquées par la CSP (`connect-src 'self' <api> https://challenges.cloudflare.com`).
- **Scénario d'attaque** : non, mais finding posture : le déploiement de Sentry-browser cassera silencieusement (Sentry capture les violations CSP… et son endpoint est lui-même bloqué — paradoxe).
- **Impact** : visibilité zéro sur les erreurs prod côté front.
- **Mitigation** : préparer la liste : `connect-src 'self' <api> https://challenges.cloudflare.com https://*.ingest.sentry.io`. À ajouter quand le SDK est intégré.
- **Effort** : 5 min le jour J.

---

### S4-009 [MEDIUM] [PROD-RISK] HSTS preload — le domaine n'est pas (vérifié) inscrit sur hstspreload.org

- **Catégorie** : MITM / TLS downgrade
- **Localisation** : `apps/web/next.config.ts:46`, `apps/studio/next.config.ts:25`, `packages/api/src/middleware/security-headers.ts:54`
- **Description** : le header HSTS contient `preload`, ce qui est la directive d'opt-in à la liste préchargée Chrome/Firefox/Safari. Mais l'inscription effective doit être faite manuellement sur https://hstspreload.org. Sans inscription, le `preload` directive est inactive — un visiteur first-time reste exposé à un MITM SSL-stripping sur sa toute première requête.
- **Scénario d'attaque** : MITM réseau sur `http://athlya.app/login` (premier visit) → l'attaquant intercepte avant que HSTS soit caché.
- **Impact** : window de vulnérabilité first-visit.
- **Mitigation** : soumettre `athlya.app` sur https://hstspreload.org après que :
  1. l'apex et `*.athlya.app` redirigent 301 vers https,
  2. tous les sous-domaines servent HSTS valid,
  3. le header est en place sur toutes les origines depuis ≥ 1 an (les changes sont irréversibles, donc patient).
- **Effort** : 30 min de checklist + 24-48h de validation Google.

---

### S4-010 [MEDIUM] [PROD-RISK] Pas de Subresource Integrity (SRI) sur le script Turnstile externe

- **Catégorie** : supply chain / MITM
- **Localisation** : `apps/web/src/components/TurnstileWidget.tsx:88-100`, `apps/studio/src/components/TurnstileWidget.tsx:50-65`
- **Description** : le widget injecte `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit">` sans attribut `integrity=` ni `crossorigin=anonymous`. Cloudflare est _trusted_ mais SRI est la défense-in-depth contre une compromission du CDN.
- **Scénario d'attaque** : compromission du CDN Cloudflare Turnstile (très improbable mais non nul) → injection de JS malveillant exécuté avec les permissions de la page.
- **Impact** : XSS sandboxé par CSP `'strict-dynamic'` (le script Turnstile a le nonce, donc tout ce qu'il injecte hérite de strict-dynamic), mais un script Turnstile compromise pourrait exfiltrer les credentials saisies dans le formulaire de login.
- **Mitigation** : SRI sur les scripts immutables. Cloudflare Turnstile **n'expose pas** d'URL versionnée (le `v0/api.js` est mutable), donc SRI n'est pas applicable directement. Alternative : self-host le `api.js` derrière une URL versionnée + SRI hash, mais perd les updates auto. Documenter la décision (accepter le risque vs self-host).
- **Effort** : décision produit, 1h de wiring si self-host.

---

### S4-011 [MEDIUM] [PROD-RISK] Idempotency cache flooding — pas de quota par-user

- **Catégorie** : DDoS / DB exhaustion
- **Localisation** : `packages/api/src/middleware/idempotency.ts`, table `idempotency_keys`
- **Description** : un user authentifié peut envoyer N requêtes mutation avec N `Idempotency-Key` différents. Chaque requête persistée dans `idempotency_keys` pendant 24h (Req 20.2). Pas de cap par-user.
- **Scénario d'attaque** : `for i in {1..1000000}; curl -X POST -H "Idempotency-Key: $i" /v1/reservations ...` → 1M lignes en 24h pour le même user.
- **Impact** : DB bloat. Latence des lookups sur la table croît. Coût stockage Neon.
- **Mitigation** :
  - Cap soft : compteur Redis `idem:count:<userId>` avec TTL 24h, max 10 000 entries/user/24h.
  - Sweeper nightly (déjà mentionné dans le module : "task 10.x") qui purge les expired (`expires_at < now()`).
- **Effort** : 1h (cap) + ack du sweeper task 10.x.

---

### S4-012 [LOW] [PROD-RISK] Headers manquants : COOP / COEP / CORP

- **Catégorie** : isolation cross-origin
- **Localisation** : `apps/web/next.config.ts`, `apps/studio/next.config.ts`, `packages/api/src/middleware/security-headers.ts`
- **Description** : aucun des headers suivants n'est émis :
  - `Cross-Origin-Opener-Policy: same-origin` — isole `window.opener` des onglets cross-origin (anti-Spectre, anti-popup-credential-theft).
  - `Cross-Origin-Embedder-Policy: require-corp` — exigé pour activer les SharedArrayBuffer et autres APIs hautes-précision.
  - `Cross-Origin-Resource-Policy: same-origin` (sur les assets servis par l'API).
- **Scénario d'attaque** : Spectre side-channel sur le browser, exfiltration via `window.opener`.
- **Impact** : durcissement manquant. Pas d'attaque connue active aujourd'hui.
- **Mitigation** : ajouter dans `staticSecurityHeaders` :
  ```ts
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' }, // 'require-corp' break Turnstile
  ```
- **Effort** : 30 min + tests E2E pour s'assurer que Turnstile/Sentry continuent à fonctionner.

---

### S4-013 [LOW] [PROD-RISK] Min TLS 1.3 non enforced via IaC — régression dashboard silencieuse possible

- **Catégorie** : TLS posture
- **Localisation** : configuration zone Cloudflare `athlya.app` (hors repo)
- **Description** : Req 25.1 ("API_Gateway SHALL accept only TLS 1.3") est satisfait par un setting dashboard Cloudflare. Si un opérateur le bascule à TLS 1.2 par erreur, aucun test ne s'en aperçoit.
- **Mitigation** : pin via Terraform Cloudflare provider (`cloudflare_zone_settings_override` `min_tls_version = "1.3"`). Ou alerte synthétique dans ZAP/Probely.
- **Effort** : 30 min Terraform.

---

### S4-014 [LOW] [PROD-RISK] `CORS_ORIGIN` non requis au boot — déploiement prod sans secret = CORS dysfonctionnel silencieux

- **Catégorie** : configuration / observability
- **Localisation** : `packages/api/src/worker.ts:135-140`, `packages/api/src/types.ts` (binding interface)
- **Description** : `CORS_ORIGIN` est lu via `(c.env as AthlyaBindings & { CORS_ORIGIN?: string }).CORS_ORIGIN` — donc optionnel. Si la secret n'est pas set en prod, la callback retourne `''` (fail-closed, bon) mais la dégradation est silencieuse — les apps web/studio cassent avec des CORS errors et il faut fouiller pour trouver la cause.
- **Mitigation** : déclarer `CORS_ORIGIN` dans `AthlyaBindings` comme champ requis ; assert `c.env.CORS_ORIGIN !== undefined` au boot dans `staging` et `production` (réutiliser le pattern `configuration_error` du middleware Turnstile).
- **Effort** : 15 min.

---

### S4-015 [LOW] [PROD-RISK] DNS rebinding — pas de Host header check côté Worker

- **Catégorie** : DNS rebinding
- **Localisation** : `packages/api/src/worker.ts` (aucun check Host)
- **Description** : Cloudflare Workers route via `route = "api.athlya.app/*"` (`wrangler.toml:env.production`). Une attaque DNS rebinding classique vise un service local sur `127.0.0.1`. Côté Worker public sur `*.workers.dev` un attaquant pourrait potentiellement re-router une requête depuis un domaine attaquant via DNS rebinding ; le routing Cloudflare valide le hostname mappé à la route, donc la fenêtre est étroite.
- **Scénario d'attaque** : marginal. Cloudflare ne dispatche pas une requête vers le Worker si le `Host` n'est pas dans le set des routes attachées. Une compromission DNS du resolver de la victime pourrait faire pointer `evil.com` vers `1.1.1.1` puis vers une IP Cloudflare ; mais Cloudflare regarde l'`Host` HTTP, pas la résolution DNS du client.
- **Impact** : très limité (CF protège).
- **Mitigation** : whitelist explicite du `Host` au top du middleware chain :
  ```ts
  app.use('*', async (c, next) => {
    const host = c.req.header('host')?.toLowerCase();
    const allowed =
      c.env.ENVIRONMENT === 'production'
        ? ['api.athlya.app']
        : c.env.ENVIRONMENT === 'staging'
          ? ['staging.api.athlya.app']
          : ['localhost:8787', '127.0.0.1:8787'];
    if (!host || !allowed.includes(host)) return c.body(null, 421); // Misdirected Request
    await next();
  });
  ```
- **Effort** : 15 min.

---

### S4-016 [INFO] [PROD-RISK] Request smuggling — non vulnérable

- **Catégorie** : HTTP smuggling
- **Localisation** : —
- **Description** : Cloudflare Workers parse HTTP nativement via le runtime V8 ; les requêtes downstream depuis le Worker (HIBP fetch, queue producer, Stripe, OpenAI éventuellement) utilisent l'API `fetch()` qui sérialise correctement. Aucun `Transfer-Encoding` ni `Content-Length` manuellement passé en aval (recherche `Transfer-Encoding|content-length` côté worker = aucune occurrence dans les chemins outbound).
- **Mitigation** : pas de mitigation requise. Maintenir cette discipline (jamais set ces headers manuellement). Ajouter un lint rule custom si on souhaite verrouiller.

---

### S4-017 [INFO] [PROD-RISK] Open redirects — non présents

- **Catégorie** : open redirect
- **Localisation** : `apps/web/src/proxy.ts`, `apps/studio/src/proxy.ts`
- **Description** : recherche `redirect|next=|returnTo` dans les apps : aucun usage de redirect basé sur query param contrôlé par l'utilisateur. Le `<RequireAuth>` redirige vers `/login` (statique). Les route handlers `/api/auth/*` ne redirigent pas (ils retournent JSON ou cookies).
- **Pas de finding actionable** ; à conserver. Ajouter un test régression si une route futur introduit `?next=...`.

---

### S4-018 [LOW] [PROD-RISK] `POST /v1/members/me/export` n'a pas de quota — abuse vector

- **Catégorie** : RGPD export abuse / DDoS DB
- **Localisation** : `packages/api/src/routes/members.ts:182-200` (`enqueueExport`)
- **Description** : `enqueueExport` est idempotent (réutilise un job pending/running existant pour le user, cf. `packages/members/src/export.ts`) donc un attaquant ne peut pas multiplier les jobs pour son propre compte. **Mais** :
  1. La route est gated par `jwtAuth` (✅) — pas un vector d'énumération de userId d'autrui (le service utilise `claims.userId`).
  2. Sans rate-limit gateway (S4-001), un user peut spammer l'endpoint et même si le job est dédupé, chaque appel exécute la query "find active job for user", la query d'audit log, etc.
- **Mitigation** : couvrir par S4-001 (rate-limit gateway) + soft-cap "1 export request per 5min per user" via Redis.
- **Effort** : couvert par S4-001.

---

## Validations positives (ne nécessitent pas d'action)

- ✅ Login response opaque (`invalid_credentials` pour user-missing, soft-deleted, OAuth-only, wrong-password) avec dummy-bcrypt pour égaliser le timing (`packages/auth/src/service.ts:687-700`).
- ✅ Refresh token rotation single-use (Req 2.2) — la route `/v1/auth/refresh` n'est _pas_ idempotente (commentaire explicite dans `routes/auth.ts:158-162`).
- ✅ HIBP fail-closed (Req 1.2) — register rejette si HIBP indisponible.
- ✅ JWKS endpoint cache-control 600s, retourne 404 si non configuré (vs JWKS vide qui serait failure mode silencieux).
- ✅ Turnstile token single-use (anti-replay), avec timeout 5s + fail-closed sur erreur réseau.
- ✅ Idempotency middleware swallow les erreurs de stockage (la réponse principale au client n'est jamais bloquée par un hiccup Postgres).
- ✅ DLQ wiring (Cloudflare Queues) avec max_retries=5 + DLQ drain admin route (`/admin/dlq/*`).
- ✅ CSP `frame-ancestors 'none'` + `X-Frame-Options: DENY` (double protection clickjacking).
- ✅ Tracing headers `traceparent`/`x-trace-id` exposés pour debug — pas d'info sensible loggée.
- ✅ Cookies `HttpOnly`, jamais lisibles depuis JS, access token en mémoire (`token-store.ts`).
- ✅ JWT issued avec `iss`/`aud` (configurable), TTL access 15min / refresh 30j.
- ✅ Pas de `*` dans CORS, pas de `Allow-Credentials: true` avec `*` origin.

---

## 3 priorités absolues

1. **S4-001 — Monter le rate-limit middleware sur `/v1/*` en production.** 30 minutes de code, débloque la conformité Req 14.3/14.4 et coupe net les vecteurs DDoS applicatifs et les abus wallet-DoS.

2. **S4-002 — Câbler `shouldAllowLogin` sur `POST /v1/auth/login`.** 1h de refactor d'interface `AuthDeps`. Sans cela, Req 1.6 (5 tentatives / 15min) est lettre morte et le credential stuffing est gratuit côté CPU bcrypt.

3. **S4-003 — Restreindre la branche dev CORS à des origins explicites localhost.** 5 minutes. La config actuelle équivaut à `Allow-Origin: *` + `Allow-Credentials: true` en dev, qui est exactement la configuration que les manuels de pentest présentent comme "ne faites jamais ça".

---

## Issue #65 — Fail-closed mutations (implémenté)

- **Code** : `packages/api/src/middleware/limiter-guard.ts` + `worker.ts`
  - `/v1/auth/*` et limiters par mutation (`POST /v1/reservations`, export, …) → **503 `dependency_unavailable`** si Upstash injoignable (staging/prod).
  - Limiter global `/v1/*` (reads) → **fail-open** pour survivre à une panne Redis.
  - `concurrencyLimit` sur réservations → fail-closed hors `dev`.
- **Defense-in-depth** : règle Cloudflare WAF recommandée — rate limit `/v1/auth/*` ~100 req/min/IP (dashboard, hors repo).

---

## Notes méthodologiques

- Cloudflare gère automatiquement et n'a pas été compté comme finding : DDoS L3/L4, TLS 1.3 (config dashboard), HTTP/2 + HTTP/3, WAF managed rules de base.
- Aucun test live exécuté côté API gateway (audit lecture seule). Les conclusions reposent sur la lecture du code source à la SHA actuelle du repo.
- Cherché et confirmé l'absence de `app.use(rateLimit())` ou équivalent dans tous les chemins de production via grep exhaustif sur les sources `packages/api/src/**`.
