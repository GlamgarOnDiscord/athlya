# Audit Sécurité S1 — Static code analysis

Date: 2026-05-15
Auditeur : analyse statique (lecture-seule)
Périmètre : `packages/**/src/**` + `apps/{web,studio}/src/**` + `pnpm audit`

## Résumé exécutif

| Sévérité | Findings |
| -------- | -------- |
| CRITICAL | 0        |
| HIGH     | 2        |
| MEDIUM   | 5        |
| LOW      | 3        |
| INFO     | 4        |

Total : 14 findings.

Posture globale : la codebase montre une **hygiène SAST très au-dessus de la moyenne** (validation Zod systématique aux frontières, paramétrage complet des requêtes SQL via `drizzle-orm`/`sql\`\``, JWT pinné RS256 + `algorithms: [JWT_ALG]`, k-anonymity HIBP correctement appliquée, comparaison HMAC Stripe via `crypto.subtle.verify`, CSP avec nonce 128 bits + `strict-dynamic`, refresh-token rotation via session ledger, secret-leak guard sur les erreurs 5xx). Les findings HIGH proviennent **exclusivement de transitive deps test-only** (`undici@5.29.0`via`testcontainers`). Les findings PROD-RISK identifiés sont mineurs (CSP `unsafe-eval`côté`next dev`correctement scopé,`postcss`Next.js 16 transitive). Aucun secret hardcodé en production, aucun`eval`/`Function()`runtime, aucun usage de`child_process` hors tests.

## Périmètre exclu (et raisons)

- **`apps/{web,studio}/.env.local`, `packages/api/.dev.vars`** — secrets de développement local. Ils ne partent pas en prod (chargés via `wrangler secret put` + Vercel env). Non audités, non reportés.
- **`packages/billing/src/__tests__/webhook.test.ts:42`** : `whsec_test_secret_…` est une valeur de test fixture déclarée littéralement, **PAS** un secret de production.
- **`packages/reservations/tests/properties/booking.property.test.ts:204` + `packages/members/tests/integration/cascade.integration.test.ts:560` + `packages/db/tests/properties/rls.property.test.ts`** : `child_process.spawnSync` appelle `psql` Testcontainers en pipeline CI. Hors périmètre (test-only, pas de chemin de production atteignable).
- Les chaînes `password`/`refreshToken`/`accessToken` apparaissant dans `packages/shared/src/schemas/api.ts` et `packages/shared/dist/i18n/index.d.ts` sont des **noms de propriétés de schéma Zod / clés i18n**, pas des valeurs.
- **CGU `BOOKING_PASSWORD = 'booking_test'`** (test PGTAP) : credential interne à un container Postgres jetable, jamais déployé.

## Findings

### S1-001 [HIGH] [DEV-ONLY] CVE-2026-1526 / CVE-2026-2229 — `undici@5.29.0` transitive via Testcontainers

- **Localisation** : `packages/{db,members,reservations}` → `testcontainers@10.28.0` → `undici@5.29.0`
- **Description** : Deux CVE HIGH :
  - **GHSA-vrm6-8vpv-qv8q** (CVE-2026-1526, CVSS 7.5) — déni de service via décompression `permessage-deflate` sans borne (decompression bomb).
  - **GHSA-v9p9-hfj2-hcw8** (CVE-2026-2229, CVSS 7.5) — exception non capturée `RangeError` sur `server_max_window_bits` invalide → crash process.
- **Scénario d'attaque** : un serveur WebSocket malveillant atteint par `undici.fetch`/`WebSocket` peut faire planter ou saturer la mémoire. **N'atteint pas la production** : Cloudflare Workers utilise son propre `fetch` natif (pas `undici`). `undici@5.29.0` n'apparaît QUE via `@testcontainers/postgresql` qui ne s'exécute qu'en CI.
- **Impact** : Nul en production. Risque limité au runner CI (jobs jetables).
- **Mitigation recommandée** : `pnpm up testcontainers@latest` (la 11.x embarque `undici>=6.24.0`). Ou ajouter une override dans `pnpm-workspace.yaml` :
  ```yaml
  overrides:
    undici: '>=6.24.0'
  ```
- **Effort** : trivial.

### S1-002 [MEDIUM] [DEV-ONLY] CVE-2026-22036 / CVE-2026-1525 / CVE-2026-1527 — `undici@5.29.0` (suite)

- **Localisation** : idem S1-001
- **Description** : Trois CVE MEDIUM supplémentaires sur la même version d'`undici` :
  - **GHSA-g9mf-h72j-4rw9** (CVE-2026-22036) — `Content-Encoding` chain unbounded → CPU/mémoire.
  - **GHSA-2mjp-6q6p-2qxm** (CVE-2026-1525) — request smuggling via `Content-Length` dupliqué case-variant.
  - **GHSA-4992-7rv2-5pvq** (CVE-2026-1527) — CRLF injection via `upgrade` option.
- **Scénario d'attaque** : aucun chemin code-side dans le projet ne passe d'input utilisateur dans les options `undici` (ni `upgrade`, ni headers user-controlled). Surface morte.
- **Impact** : nul en production (Workers `fetch`), faible en CI.
- **Mitigation recommandée** : même que S1-001 (mise à jour transitive).
- **Effort** : trivial.

### S1-003 [MEDIUM] [PROD-RISK] CVE-2026-41305 — `postcss@8.4.31` via Next.js 16

- **Localisation** : `apps/{studio,web}` → `next@16.2.6` → `postcss@8.4.31`
- **Description** : XSS via `</style>` non échappé dans la sortie de stringification CSS (GHSA-qx2v-qp2m-jg93, CVSS 6.1).
- **Scénario d'attaque** : un attaquant qui contrôle du CSS injecté côté serveur (theming brand-color) peut casser la balise `<style>` et exécuter du JS. **Mitigé partiellement** par : (1) le CSP strict `script-src 'nonce-…' 'strict-dynamic'` qui bloquerait tout `<script>` injecté sans nonce, (2) le serveur n'accepte pas de CSS arbitraire — seul `brandColor: HexColorSchema` (`/^#[0-9A-Fa-f]{6}$/`) est passé au CSS-in-JS via `evaluateBrandContrast` (validation Zod stricte).
- **Impact** : faible (defence-in-depth via CSP + validation regex stricte) mais reste un finding upstream.
- **Mitigation recommandée** : attendre la mise à jour transitive de Next 16 (Next.js doit bumper `postcss` ≥ 8.5.10). En attendant, ajouter une override pnpm :
  ```yaml
  overrides:
    postcss: '>=8.5.10'
  ```
- **Effort** : trivial.

### S1-004 [MEDIUM] [DEV-ONLY] CVE GHSA-67mh-4wv8-2f99 — `esbuild@0.18.20` via `drizzle-kit`

- **Localisation** : `packages/db` → `drizzle-kit@0.31.10` → `@esbuild-kit/esm-loader@2.6.5` → `esbuild@0.18.20`
- **Description** : Le serveur de dev `esbuild` accepte CORS `*` sur tous les endpoints — n'importe quel site web peut lire le bundle source servi en local.
- **Scénario d'attaque** : un dev qui visite un site malveillant pendant qu'il run `drizzle-kit studio` peut voir son bundle exfiltré.
- **Impact** : nul en prod (drizzle-kit n'est exécuté qu'en dev/CI). Faible côté dev.
- **Mitigation recommandée** : `pnpm up drizzle-kit@latest` (les versions récentes bumpent `esbuild` ≥ 0.25). Ou pnpm override `esbuild: ">=0.25.0"`.
- **Effort** : trivial.

### S1-005 [MEDIUM] [PROD-RISK] CSP autorise `'unsafe-eval'` — vérifier rigueur du gating

- **Localisation** : `apps/web/src/lib/csp.ts:88`, `apps/studio/src/lib/csp.ts:39`, `apps/web/src/proxy.ts:78`, `apps/studio/src/proxy.ts:42`
- **Description** : Le CSP ajoute `'unsafe-eval'` à `script-src` quand `dev=true`. Le toggle est calculé via `process.env.NODE_ENV !== 'production'` — un build prod déployé avec `NODE_ENV` mal défini retomberait sur la version laxiste.
- **Scénario d'attaque** : un attaquant XSS exploitant un sink R/W (impossible sans S1-003 d'abord) peut déclencher `eval(malicious)`. Le risque concret est conditionné à la défaillance d'au moins deux contrôles (mauvais NODE_ENV + sink XSS).
- **Impact** : moyen (defence-in-depth dégradée si NODE_ENV mal positionné).
- **Mitigation recommandée** : verrouiller le flag à un secret de build dédié (`PROD_CSP=1` côté Vercel) plutôt que `NODE_ENV`, ou émettre une assertion runtime au boot qui crash si `NODE_ENV !== 'production'` quand l'environnement Vercel n'est pas `preview`. Bonus : ajouter un test E2E qui assert `'unsafe-eval'` absent des response headers en prod.
- **Effort** : small.

### S1-006 [MEDIUM] [PROD-RISK] CSP `style-src` retombe sur `'unsafe-inline'` quand `isDev=true`

- **Localisation** : `apps/web/src/lib/csp.ts:101-103`, `apps/studio/src/lib/csp.ts:41-44`
- **Description** : Quand `isDev=true`, `style-src` est `'self' 'unsafe-inline'` — les nonces sont délibérément retirés (CSP L2 ignore `'unsafe-inline'` si un nonce est présent). Mêmes risques que S1-005 : un mauvais positionnement de `NODE_ENV` dégrade la posture en prod.
- **Scénario d'attaque** : XSS injectant un `<style>` malicieux (ex. exfil via background-image: url) passerait en dev. Combiné à S1-003 ce serait critique. En prod, idem que S1-005.
- **Impact** : moyen (defence-in-depth).
- **Mitigation recommandée** : même approche que S1-005 — attacher le toggle à un secret de build dédié. Vérifier en CI/E2E qu'aucun header response prod ne contient `'unsafe-inline'` dans `style-src`.
- **Effort** : small.

### S1-007 [LOW] [PROD-RISK] `withTenant` — JSON.parse(JWKS_JSON) sur input env sans validation forte

- **Localisation** : `packages/api/src/adapters/auth-deps.ts:107`
- **Description** : `JSON.parse(wider.JWKS_JSON) as Jwks` casse le typage Zod sur le JWKS chargé depuis `env.JWKS_JSON`. Si la string est corrompue ou si un opérateur push un JWKS avec `kty: 'oct'` (HMAC), `jose` pourrait l'accepter et émettre un cas dégradé. Mitigé par `algorithms: ['RS256']` côté `jwt.ts:317` et `auth.ts:359` qui rejette toute clé symétrique.
- **Scénario d'attaque** : un opérateur (insider) pousse un JWKS sans `kid` ou avec `alg` autre que RS256 ; le service échoue silencieusement à vérifier les tokens (faux positifs côté `invalid_token`). Pas un vecteur attaquant externe.
- **Impact** : faible. Erreur d'opération qui surfacerait via 401 sur tout le trafic — détection rapide.
- **Mitigation recommandée** : valider le JWKS au boot avec un Zod schema (`{ keys: array(z.object({ kty, kid, alg, n, e, use })) }`), throw au boot si KO.
- **Effort** : small.

### S1-008 [LOW] [PROD-RISK] `sql.raw` sur noms de colonnes (pas d'input user, mais pattern à éviter)

- **Localisation** : `packages/db/src/schema/_shared.ts:80,87`
  ```ts
  export function sqlIsNull(column: string): SQL {
    return sql.raw(`"${column}" IS NULL`);
  }
  ```
- **Description** : `sql.raw` interpole `column` directement dans la string SQL **sans paramétrage**. Les call-sites actuels passent uniquement des littéraux compilés (`'deleted_at'`, `'cancelled_at'`) — aucun input utilisateur n'atteint cette fonction. Mais le pattern est dangereux si un futur appelant passe une string non-littérale.
- **Scénario d'attaque** : un développeur futur passe `column: req.query.col` → SQL injection triviale.
- **Impact** : faible aujourd'hui (pas exploitable), élevé si misuse futur.
- **Mitigation recommandée** : (a) passer `column: ColumnIdentifier` (type branded) au lieu de `string`, ou (b) valider via regex `^[a-z_][a-z0-9_]*$` au runtime, ou (c) supprimer ces helpers et utiliser directement `isNull(table.column)` de drizzle (Drizzle expose ces helpers natifs et type-safes).
- **Effort** : trivial à small.

### S1-009 [LOW] [PROD-RISK] HIBP — User-Agent permet fingerprinting

- **Localisation** : `packages/auth/src/hibp.ts:130`
- **Description** : `'User-Agent': 'athlya-auth/1 (+https://athlya.app)'` — exposition gratuite du nom du service à HIBP. Pas un risque de sécurité ; un risque de privacy/posture.
- **Scénario d'attaque** : néant. Ne fuite pas de mot de passe ni de hash (k-anonymity respectée).
- **Impact** : informatif.
- **Mitigation recommandée** : OK tel quel (HIBP exige un UA stable). Optionnellement remplacer par `'athlya/1'` plus opaque.
- **Effort** : trivial.

### S1-010 [INFO] [PROD-RISK] Plusieurs `as unknown as` — masquage potentiel de typing

- **Localisation** :
  - `packages/auth/src/service.ts:494,513` (cast `AthlyaEvent`)
  - `packages/db/src/idempotency.ts:145`, `packages/db/src/outbox.ts:201` (drizzle row narrowing — justifié par limitations runtime)
  - `packages/api/src/adapters/members-deps.ts:115` + `auth-deps.ts` (queue type Cloudflare — `FIXME(B8.3)` documenté)
  - `packages/api/src/routes/helpers.ts:144` (`(c as any).get` — read d'un slot Hono dynamique)
  - `packages/api/src/routes/index.ts` (forward methods dans la lazy facade)
- **Description** : Aucun de ces casts ne masque un risque sécurité direct : (1) le cast `AthlyaEvent` est suivi d'un `publish()` qui émet sur la file, le payload n'est pas interpolé en SQL ; (2) les casts drizzle row contournent une limitation typage côté postgres-js mais les colonnes restent paramétrées ; (3) `c as any).get` est juste un read sur le bag de variables Hono. Les chaînes ne croisent jamais d'input utilisateur sans validation préalable.
- **Impact** : informatif.
- **Mitigation recommandée** : le `FIXME(B8.3)` sur le cast `Queue` mérite résolution ; les autres sont acceptables avec leur commentaire de justification.
- **Effort** : medium.

### S1-011 [INFO] [PROD-RISK] `process.env` directement lu hors helpers typés

- **Localisation** : `apps/web/src/proxy.ts:78`, `apps/studio/src/proxy.ts:42`, `apps/{web,studio}/src/app/api/auth/*/route.ts` (NODE_ENV uniquement)
- **Description** : Les helpers typés (`apps/{web,studio}/src/lib/env.ts`) couvrent `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `NEXT_PUBLIC_CSP_REPORT_URI`. Le seul accès direct hors helper est `process.env['NODE_ENV']` (et `process.env.NODE_ENV` dans i18n) — variable Next.js standard, pas un secret.
- **Impact** : informatif. Conformité au pattern attendu.
- **Mitigation recommandée** : optionnellement ajouter `getNodeEnv()` au helper pour homogénéité.
- **Effort** : trivial.

### S1-012 [INFO] [DEV-ONLY] `eval()` mention dans CSP dev — documenté

- **Localisation** : `apps/web/src/lib/csp.ts:42-46`, `apps/web/src/proxy.ts:84`
- **Description** : `'unsafe-eval'` est conditionné à `dev` runtime flag pour permettre les source-maps stack-traces React dev. **Aucun appel `eval()` runtime dans le code source du projet** (vérifié via grep — seuls les commentaires et les arbitraires fast-check `nonEmpty…` matchent). Bien documenté.
- **Impact** : informatif (déjà couvert par S1-005).
- **Mitigation recommandée** : voir S1-005.
- **Effort** : voir S1-005.

### S1-013 [INFO] [PROD-RISK] `Math.random` fallback dans tracing/ids et reservations/cancel

- **Localisation** : `packages/api/src/tracing/ids.ts:208`, `packages/reservations/src/cancel.ts:360`
- **Description** : Fallback `Math.random` quand `crypto.getRandomValues` indisponible. Sur Cloudflare Workers et Node 20 le fallback n'est jamais pris (`crypto` toujours présent). Les deux call-sites le documentent explicitement.
- **Scénario d'attaque** : néant en production. Théoriquement, sur une plateforme exotique sans Web Crypto, des trace-ids et UUIDs prédictibles. Ne touche pas les claims JWT, les nonces CSP ni les `jti` QR (ceux-ci passent par `crypto.randomUUID()` avec assertion non-empty).
- **Impact** : informatif. Surface morte sur Workers/Node 20.
- **Mitigation recommandée** : remplacer le fallback par `throw new Error('Web Crypto unavailable')` au lieu de retomber sur `Math.random`. Plus loud en cas de runtime exotique.
- **Effort** : trivial.

### S1-014 [INFO] [PROD-RISK] `bcrypt.compare` n'est pas explicitement timing-safe documenté

- **Localisation** : `packages/auth/src/password.ts:80`
- **Description** : `bcryptjs.compare` est implémentée pour être timing-safe sur la string complète (constant-time ASCII comparison interne). Le service auth (`packages/auth/src/service.ts:loginPath`) compense même la branche "user not found / OAuth-only" via un hash fictif (`DUMMY_HASH`) pour uniformiser les latences. Bien fait.
- **Impact** : informatif.
- **Mitigation recommandée** : ajouter un commentaire explicite dans `password.ts:verify` rappelant que `bcryptjs.compare` est timing-safe.
- **Effort** : trivial.

## Bonnes pratiques observées (non-findings)

Les pratiques suivantes ont été vérifiées et sont **conformes ou supérieures** aux standards :

1. **bcrypt cost 12** (`packages/auth/src/password.ts:32`) — OWASP 2024 lower bound respecté.
2. **JWT pinning RS256 strict** — `jwtVerify` reçoit `algorithms: ['RS256']` à TROIS endroits (`auth.ts:362`, `jwt.ts:317`, `qr.ts:285`). Algo confusion (HS256 → RS256) impossible. Le test `auth.test.ts:401` "rejects a token signed with HS256 instead of RS256" assert le comportement.
3. **`alg: none` rejeté** — la liste blanche `['RS256']` exclut nativement `none`.
4. **`kid` validation** — chaque JWT mint stamp un `kid` (`jwt.ts:236,272`, `qr.ts:234`); le verify charge le JWKS local et `jose` matche par `kid`.
5. **JWT key rotation** — `rotateKeys` + `currentJwks` impose `previous.kid !== next.kid`, demote l'ancienne clé avec `notAfter = now + 24h` (Req 25.5).
6. **`withTenant` (db/client.ts)** — claims validées par `validateClaims` (regex UUID v1-8, role enum) AVANT toute requête SQL. Trois `set_config()` sont en plus paramétrés via `${safe.userId}` etc., pas concaténés. Defense-in-depth.
7. **Toutes les requêtes SQL paramétrées** — chaque `tx.execute(sql\`...\`)`audité (idempotency.ts, outbox.ts, client.ts) utilise des placeholders`${value}`. `sql.raw`est confiné à`\_shared.ts` sur des noms de colonnes littéraux compilés (voir S1-008).
8. **HIBP k-anonymity** — `hibp.ts:113-127` envoie SEULEMENT le préfixe SHA-1 des 5 premiers caractères. Le full hash et le password ne quittent jamais le worker. Suffix scan sur la réponse, comparison case-insensitive, support `Add-Padding: true`.
9. **CSP nonces 128 bits** — `nonce.ts:7-12` appelle `crypto.getRandomValues(new Uint8Array(16))` (= 128 bits) puis encode base64url. Conforme Req 25.3. Identique entre `apps/web` et `apps/studio`.
10. **HMAC Stripe constant-time** — `webhook.ts:426` utilise `crypto.subtle.verify` (specified constant-time). Itération ne short-circuite pas (commentaire ligne 433-435 explicite).
11. **Stripe webhook timestamp tolerance** — `verifyStripeSignature` impose `|now - t| <= 300s` symétrique (anti-replay et anti-future-dated).
12. **CSP `frame-ancestors 'none'`** + `X-Frame-Options: DENY` — clickjacking impossible.
13. **HSTS** `max-age=63072000; includeSubDomains; preload` (Req 25.2) — preload-list compatible.
14. **Cookies refresh** `HttpOnly; Secure (prod); SameSite=Lax; Path=/` — JS lock-out total. Refresh tokens jamais accessibles depuis le navigateur.
15. **Validation Zod systématique** — chaque route `/v1/*` a `zValidator(target, Schema)` ; toutes les schemas sont `.strict()` (rejet des champs inconnus). `c.req.json()` n'est jamais appelé sans validation préalable (vérifié par grep).
16. **Tailles bornées sur strings sensibles** :

- `password`: min 8, max 72 (RegisterRequest) / min 1, max 72 (LoginRequest) — conforme bcrypt 72-byte limit.
- `email`: max 254 (RFC 5321).
- `displayName`: trim, min 1, max 80.
- `Idempotency-Key`: trim + max 255 chars (vérifié à la fois dans le middleware et dans le helper DB).

17. **Login throttle** — `auth/throttle.ts` : sliding-window 5 attempts / 15 min keyé sur `(IP, normalized email)`. Email lower-cased + trimmed pour empêcher le bypass casse.
18. **Refresh token rotation single-use** — `SessionStore.rotate(oldSid, newSid)` atomique ; `rotated === false` → `token_invalid` immédiat.
19. **JWT verify clockTolerance 0** — `auth.ts:355`, `qr.ts:286` : pas de skew toléré (gateway/serveurs NTP-synced).
20. **Secret-leak guard sur 500** — `problem-details.ts:386,431-451` : la response 500 NE contient JAMAIS `err.message`/`err.stack`/`err.cause`. Tout part en log structuré côté serveur, traceId seul dans la response.
21. **Sentry capture original error** — Hook `onFiveHundred` reçoit l'erreur originale (commentaire 613-616 explicite).
22. **Stripe-Signature redacted** — `webhook.ts:546` : `metadata.signatureHeader: '[REDACTED]'`. Test `webhook.test.ts:566-592` assert.
23. **Logger fields redaction** — `logging.ts:DEFAULT_REDACTED_KEYS` couvre `password`, `token`, `authorization`, `stripeSignature`, `secret`. Helper `redactKeys()` exposé.
24. **Aucun `console.log` exposant un secret** — l'inspection de toutes les occurrences `console.{log,info,warn,error,debug}` montre uniquement des structures `{ traceId, eventId, eventType, error: err.message, ... }` ou des warns de configuration.
25. **Aucun `eval` runtime** — vérifié via grep. Seules occurrences : commentaires CSP + `nonEmpty…` arbitraires fast-check (faux positif regex).
26. **Aucun `child_process` runtime** — uniquement dans les tests integration (Testcontainers PGTAP).
27. **Aucun `Function()` runtime** — verifié.
28. **`new URL(...)` sur env trusted** — JWT_JWKS_URL est traité comme config opérationnelle (commentaire `auth.ts:184-188` explicite). Aucun input utilisateur passé à `new URL()`.
29. **Tenant resolver SSRF-proof** — la tenant resolution ne fait AUCUNE requête réseau ; lookup pur sur le host string + path regex.
30. **Turnstile fail-closed en staging/prod** — secret manquant → 500 `configuration_error`. Dev-only bypass loggé.
31. **CORS strict** — `worker.ts:97-115` : whitelist exacte (origin === allowed), pas de wildcard, credentials true seulement sur origin explicite.
32. **No-store / no-cache cookies refresh** — implicite via `set-cookie` sans cache headers.
33. **Idempotency DB store TTL** — 24h, query-level expiry check (`expires_at > now()`) — pas de race avec sweeper.
34. **Outbox `ON CONFLICT (event_id) DO NOTHING`** — retry safety.
35. **QR jti replay** — `qr.ts:317-326` ordering : signature d'abord, puis `kind`, puis `studio`, puis replay store. Forge ne peut pas polluer le replay set.

## Score sécurité statique global

**87 / 100**

Calcul indicatif :

- Base : 100
- −2 × HIGH (mais DEV-ONLY) : −4
- −5 × MEDIUM (3 PROD-RISK, 2 DEV-ONLY) : −7
- −3 × LOW (PROD-RISK) : −3
- INFO : 0

Posture générale : **excellente**. Les bugs typiques d'un audit SAST (SQL injection, hardcoded secrets, JWT algo confusion, CSP laxiste, secrets dans logs, `eval`/`exec` runtime) sont **absents**. Les findings PROD-RISK identifiés sont des durcissements supplémentaires (nettoyage `sql.raw`, gating CSP plus strict, validation JWKS au boot, mise à jour transitive `postcss`).

## 3 priorités absolues

1. **Bumper `postcss` ≥ 8.5.10** via override pnpm — seul finding upstream PROD-RISK encore exploitable (XSS via `</style>` non échappé). Effort trivial.
2. **Verrouiller le toggle CSP `dev`/`isDev` à un secret de build dédié** plutôt que `NODE_ENV`. Ajouter une assertion E2E qui assert `'unsafe-eval'` et `'unsafe-inline'` absents en réponse de prod. Élimine S1-005 et S1-006. Effort small.
3. **Mettre à jour `testcontainers` (et donc `undici`)** pour fermer les 5 CVE transitives, même DEV-ONLY. Permet aussi de rester dans une fenêtre `pnpm audit` propre côté pipeline `deps-audit.yml`. Effort trivial.

Pistes complémentaires (post-priorités) :

- Remplacer `_shared.ts:sqlIsNull/sqlIsNotNull` par les helpers natifs de drizzle pour éliminer l'usage de `sql.raw`.
- Valider `JWKS_JSON` au boot avec un Zod schema (S1-007).
- Résoudre le `FIXME(B8.3)` sur le cast Queue Cloudflare.
