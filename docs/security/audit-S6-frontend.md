# Audit Sécurité S6 — Frontend (web + studio)

Date: 2026-05-15
Périmètre: `apps/web` (member-facing, Next.js 16) + `apps/studio` (admin, Next.js 16)
Mode d'audit: lecture statique du code + tests HTTP des deux apps en mode `next dev`.
Auditeur: Kiro (sub-agent S6 frontend security audit).

---

## Résumé exécutif

| Sévérité           | Nombre |
| ------------------ | ------ |
| CRITICAL           | 0      |
| HIGH               | 1      |
| MEDIUM             | 3      |
| LOW                | 4      |
| INFO               | 3      |
| **Total findings** | **11** |

**Score global frontend: 82 / 100.**

L'enveloppe sécurité côté client est solide (CSP nonce strict, `frame-ancestors 'none'`, HSTS preloaded, refresh token httpOnly+SameSite=Lax+Secure, access token en mémoire seulement, aucun `dangerouslySetInnerHTML` / `eval` / `innerHTML=` dans le code applicatif, `autocomplete` correct sur les forms d'auth, aucun open redirect). Les écarts identifiés sont majoritairement des durcissements défensifs (Permissions-Policy, COOP/COEP, SRI Turnstile) sauf un point bloquant en production: la CSP `style-src` strict-prod ne couvre pas les `style="..."` attributs inline (React `style={{...}}`), ce qui cassera certains composants (notamment `BrandingPreview`, Base UI dialog/popover, react-day-picker, sonner toasts) dès qu'on quittera `next dev`.

### 3 priorités

1. **S6-001 (HIGH)** — Production: la CSP `style-src 'self' 'nonce-...'` (sans `'unsafe-inline'` ni `style-src-attr 'unsafe-inline'`) va bloquer les attributs HTML `style="..."` que React émet pour `style={{...}}`. **À tester en `pnpm start` avant déploiement** et corriger via `style-src-attr 'unsafe-inline'` ou en migrant les rares inline styles vers des classes / variables CSS.
2. **S6-002 (MEDIUM)** — Ajouter `Permissions-Policy` sur les deux apps (par défaut: `camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=(), usb=()`) pour réduire la surface d'exploitation post-XSS.
3. **S6-003 (MEDIUM)** — Ajouter `Cross-Origin-Opener-Policy: same-origin` (et idéalement `Cross-Origin-Resource-Policy: same-origin`) pour isoler le contexte navigation, surtout côté `studio` où l'utilisateur a des privilèges admin.

---

## Headers de sécurité observés

Tests effectués via `curl -sI http://localhost:3000/` et `…:3001/` après `pnpm --filter @athlya/{web,studio} dev` (Next.js 16.2.6 + Turbopack, `NODE_ENV=development`).

> ⚠️ Les valeurs CSP observées ci-dessous incluent les relaxations dev (`'unsafe-eval'` sur `script-src`, `'unsafe-inline'` sur `style-src`). Le code de `lib/csp.ts` retire ces deux relaxations dès que `process.env.NODE_ENV === 'production'`.

### apps/web (port 3000)

| Header                         | Valeur (dev)                                                                                                                                  | Verdict                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `X-Frame-Options`              | `DENY`                                                                                                                                        | ✅                                                                     |
| `Referrer-Policy`              | `strict-origin`                                                                                                                               | ✅                                                                     |
| `X-Content-Type-Options`       | `nosniff`                                                                                                                                     | ✅                                                                     |
| `Strict-Transport-Security`    | `max-age=63072000; includeSubDomains; preload`                                                                                                | ✅ (preloaded ⇒ il faut être sûr de tous les sous-domaines avant prod) |
| `Content-Security-Policy`      | nonce + `strict-dynamic`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `upgrade-insecure-requests` | ✅ shape; ⚠️ voir S6-001 pour `style-src` prod                         |
| `Permissions-Policy`           | absent                                                                                                                                        | ❌                                                                     |
| `Cross-Origin-Opener-Policy`   | absent                                                                                                                                        | ❌                                                                     |
| `Cross-Origin-Resource-Policy` | absent                                                                                                                                        | ❌                                                                     |
| `Cross-Origin-Embedder-Policy` | absent                                                                                                                                        | ❌ (acceptable: COEP=require-corp casse beaucoup d'embeds)             |
| `Cache-Control` (HTML)         | `no-cache, must-revalidate`                                                                                                                   | ✅                                                                     |
| `X-Powered-By`                 | `Next.js`                                                                                                                                     | ⚠️ leak mineur (info banner)                                           |
| `Set-Cookie` (refresh, prod)   | `HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=…`                                                                                           | ✅                                                                     |
| `Report-To`                    | non émis (`NEXT_PUBLIC_CSP_REPORT_URI` vide en local)                                                                                         | ℹ️ attendu en local; à activer en prod                                 |

### apps/studio (port 3001)

| Header                         | Valeur (dev)                                                                    | Verdict                                   |
| ------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------- |
| `X-Frame-Options`              | `DENY`                                                                          | ✅                                        |
| `Referrer-Policy`              | `strict-origin`                                                                 | ✅                                        |
| `X-Content-Type-Options`       | `nosniff`                                                                       | ✅                                        |
| `Strict-Transport-Security`    | `max-age=63072000; includeSubDomains; preload`                                  | ✅                                        |
| `Content-Security-Policy`      | identique à `apps/web`                                                          | ✅ shape; ⚠️ S6-001                       |
| `Permissions-Policy`           | absent                                                                          | ❌                                        |
| `Cross-Origin-Opener-Policy`   | absent                                                                          | ❌ (≥ MEDIUM ici, c'est le panneau admin) |
| `Cross-Origin-Resource-Policy` | absent                                                                          | ❌                                        |
| `Set-Cookie` (refresh, prod)   | `HttpOnly; SameSite=Lax; Secure; Path=/`; cookie name = `athlya.refresh.studio` | ✅                                        |
| `X-Powered-By`                 | `Next.js`                                                                       | ⚠️                                        |

---

## Couverture par classe d'attaque

| Catégorie                        | Statut                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Reflected/Stored/DOM XSS**  | ✅ Géré par React JSX escape; aucun `dangerouslySetInnerHTML`, `innerHTML =`, `eval`, `new Function`, `setTimeout(string)` ou `location.hash` dans le code applicatif (`apps/{web,studio}/src/**`). Les seules occurrences trouvées sont dans le runtime Next.js / React-DOM compilé (`.next/dev/...`), c'est-à-dire le framework lui-même — non audité. |
| **B. CSRF**                      | ✅ Refresh & logout utilisent un cookie `SameSite=Lax` httpOnly. Login/register sont publics; pas de cookie d'auth requis donc CSRF non applicable. La protection repose entièrement sur SameSite=Lax — voir S6-005 pour le durcissement Origin/Referer.                                                                                                 |
| **C. Storage misuse**            | ✅ Access token uniquement en mémoire (`token-store.ts`, module-scoped, pas exposé sur `window`). Refresh token uniquement en cookie httpOnly. Aucun `localStorage.setItem`, `sessionStorage.setItem`, `indexedDB.open` dans le code applicatif.                                                                                                         |
| **D. CSP enforcement**           | ✅ Header (pas meta) avec nonce 128-bit par requête, `strict-dynamic`, `frame-ancestors 'none'`, reporting optionnel. ⚠️ Trou prod sur les inline `style=""` attributs — voir S6-001.                                                                                                                                                                    |
| **E. Clickjacking**              | ✅ `X-Frame-Options: DENY` + `frame-ancestors 'none'`. Defense in depth correcte.                                                                                                                                                                                                                                                                        |
| **F. Open redirects**            | ✅ Aucun consommateur de `?next=` / `?redirect=` / `?return_to=`. Toutes les redirections post-login utilisent des paths statiques (`/`, `/dashboard`, `/login`, `/forbidden`). `useSearchParams` n'est utilisé nulle part dans `apps/{web,studio}/src/**`.                                                                                              |
| **G. SRI**                       | ❌ Le script Turnstile (`challenges.cloudflare.com/turnstile/v0/api.js`) est injecté sans `integrity=` ni `crossorigin=`. Cloudflare ne publie pas de hash stable pour ce script (rotation interne) → mitigation impossible sans renoncer aux mises à jour. À documenter comme accepted risk. Voir S6-007.                                               |
| **H. Auth state leaks**          | ✅ Token store module-scoped, jamais publié sur `window`. Pas de log du token dans la console. ⚠️ Voir S6-009 sur les Server Actions / route handlers qui propagent l'access token via header `Authorization`.                                                                                                                                           |
| **I. Form security**             | ✅ Tous les forms `/login`, `/register`, `/me` ont des `autocomplete` corrects (`email`, `current-password`, `new-password`, `off` sur le confirm-text destructif).                                                                                                                                                                                      |
| **J. Source maps prod**          | ✅ `productionBrowserSourceMaps` non défini → défaut Next.js = `false` → aucune source map publiée en prod. À auditer côté CDN une fois le déploiement Cloudflare actif (Sentry uploadera les maps en build, pas servies).                                                                                                                               |
| **K. Service worker / manifest** | ℹ️ Aucun service worker, aucun `manifest.webmanifest` présent dans `apps/web/public/` ni `apps/studio/public/`. Ni risque ni couverture PWA.                                                                                                                                                                                                             |
| **L. File upload (avatar)**      | ⚠️ `ProfileForm.tsx` accepte image/png, image/jpeg, image/webp via `accept` (client-only), cap 256 KiB, jamais SVG (donc pas de XSS via SVG `<script>`). Pas de check magic-byte côté client — server-side responsabilité (hors périmètre frontend). Voir S6-010.                                                                                        |
| **M. Tests headers HTTP**        | Effectués (cf. tableaux ci-dessus). Servers stoppés.                                                                                                                                                                                                                                                                                                     |

---

## Findings

### S6-001 [HIGH] [PROD-RISK] CSP `style-src` strict bloque les attributs `style=""` inline en prod

- **Catégorie**: CSP enforcement
- **App**: les deux (web + studio)
- **Localisation**: `apps/web/src/lib/csp.ts:96-99`, `apps/studio/src/lib/csp.ts:39-42`
- **Description**: en production le builder CSP émet `style-src 'self' 'nonce-${nonce}'` (sans `'unsafe-inline'` et sans `style-src-attr`). Un `nonce-` n'est honoré que pour les éléments `<style>` server-rendered, **pas pour les attributs HTML `style="..."` inline**. Or React émet exactement ces attributs pour toute prop `style={{...}}` (cf. `apps/studio/src/app/dashboard/branding/BrandingPreview.tsx:147,161` qui rend `<div style={{ backgroundColor: currentColor }}/>`). De plus, plusieurs libs UI utilisées (Base UI Dialog/Popover/Sheet pour le positionnement, `react-day-picker` côté studio, `sonner` Toaster) injectent en runtime des `style=""` (transform, top/left, opacity) — qui seront eux aussi bloqués par cette CSP.
- **Scénario d'attaque**: pas un vecteur d'attaque — c'est un bug de runtime production qui produira un FOUC (perte du `transform`, des positions absolues, des couleurs dynamiques) **et** un flux de violations CSP qui spammera le `report-uri`. La pression "ça marche en dev, pas en prod" pousse traditionnellement à rajouter `'unsafe-inline'` global, ce qui dégrade fortement la CSP en réintroduisant le vecteur stored XSS via `<style>` injection.
- **Impact**: dégradation visible en prod (BrandingPreview cassé, dialogs mal positionnés), risque de régression CSP par rollback `'unsafe-inline'`.
- **Mitigation**:
  1. Ajouter `style-src-attr 'unsafe-inline'` dans `lib/csp.ts` (CSP Level 3, supporté Chromium ≥ 76, Firefox ≥ 70). Cela autorise les attributs `style=""` mais conserve la stricte sur les `<style>` blocks.
  2. **Alternative plus stricte**: refactorer `BrandingPreview` pour injecter une `<style nonce={…}>` server-rendered qui définit `--brand-color: …` puis utiliser `class="bg-[var(--brand-color)]"` en Tailwind 4 — supprime le seul inline applicatif. Les libs tierces nécessiteront quand même `style-src-attr 'unsafe-inline'`.
- **Tests à ajouter**: faire tourner la suite e2e Playwright contre `pnpm build && pnpm start` (NODE_ENV=production) avec un browser arg `--enable-experimental-web-platform-features`, capturer les violations CSP via `console.error` listener.
- **Effort**: 1 h (option 1) à 4 h (option 2 + e2e).

### S6-002 [MEDIUM] [PROD-RISK] Header `Permissions-Policy` absent

- **Catégorie**: hardening / defense-in-depth
- **App**: les deux
- **Localisation**: `apps/web/next.config.ts:30-46`, `apps/studio/next.config.ts:25-31` (liste `staticSecurityHeaders`)
- **Description**: aucun header `Permissions-Policy`. Une XSS exploitée pourrait dans certains scénarios accéder aux APIs `geolocation`, `camera`, `microphone`, `payment`, `usb`, `serial`, `bluetooth`, etc. sans qu'aucune barrière n'existe au-delà de la prompt browser native.
- **Scénario d'attaque**: post-exploitation XSS. L'attaquant injecte un script qui ouvre `navigator.mediaDevices.getUserMedia({ audio: true })` pour récolter de l'audio. Sans Permissions-Policy, le browser n'oppose qu'un prompt utilisateur (qui peut être bypassé par hijack de gesture ou par user-fatigue).
- **Impact**: amplification d'une XSS en compromission micro/géoloc/payment.
- **Mitigation**: ajouter dans `staticSecurityHeaders`:
  ```
  { key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), serial=(), midi=(), accelerometer=(), gyroscope=(), magnetometer=(), interest-cohort=()' }
  ```
- **Effort**: 5 min.

### S6-003 [MEDIUM] [PROD-RISK] Headers `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy` absents

- **Catégorie**: cross-origin isolation
- **App**: les deux (priorité plus forte sur `studio`)
- **Localisation**: `apps/{web,studio}/next.config.ts`
- **Description**: pas de `Cross-Origin-Opener-Policy: same-origin`, pas de `Cross-Origin-Resource-Policy: same-origin`. COOP isole la fenêtre des autres origins ouvertes via `window.open` / `target=_blank` (anti tabnabbing avancé, anti Spectre cross-window). CORP empêche les ressources de l'app d'être chargées par d'autres origins via `<img>`, `<script>`, etc.
- **Scénario d'attaque**: le studio admin clique sur un lien externe ouvert dans un nouvel onglet — le site externe peut tenter `window.opener.postMessage` ou des side-channels. Avec COOP=`same-origin`, le `window.opener` est cassé proprement.
- **Impact**: defense-in-depth manquante; surface d'attaque side-channel non isolée.
- **Mitigation**: ajouter aux headers statiques:
  ```
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' }
  ```
  Ne pas activer COEP=`require-corp` sans audit séparé (casse le widget Turnstile et tout asset cross-origin sans CORP côté serveur).
- **Effort**: 10 min + e2e regression.

### S6-004 [LOW] [PROD-RISK] Header `X-Powered-By: Next.js` exposé

- **Catégorie**: information disclosure
- **App**: les deux
- **Localisation**: `apps/{web,studio}/next.config.ts` — manque `poweredByHeader: false`
- **Description**: les deux apps émettent `X-Powered-By: Next.js`, ce qui révèle le framework et donc le set de CVE applicables. Le header est désactivable proprement par `poweredByHeader: false` dans `nextConfig`.
- **Impact**: facilite le fingerprinting et la sélection d'exploits; pas d'attaque directe.
- **Mitigation**: `poweredByHeader: false` dans `next.config.ts` des deux apps.
- **Effort**: 2 min.

### S6-005 [LOW] [PROD-RISK] Pas de validation Origin/Referer sur les route handlers `/api/auth/*`

- **Catégorie**: CSRF / defense-in-depth
- **App**: les deux
- **Localisation**: `apps/web/src/app/api/auth/{login,logout,refresh,register}/route.ts`, `apps/studio/src/app/api/auth/{login,logout,refresh}/route.ts`
- **Description**: la protection CSRF repose à 100 % sur le cookie `SameSite=Lax`. SameSite=Lax bloque effectivement les POST cross-site (sauf top-level navigations GET/HEAD/OPTIONS) — donc le risque réel est faible. Cependant, en defense-in-depth, ajouter une vérification `Origin` / `Referer` sur les POST `/api/auth/refresh` et `/api/auth/logout` (cookie-authenticated) protégerait contre les UA legacy ou les bugs de browser SameSite.
- **Scénario d'attaque**: un browser pre-Chromium (ou un futur bug regression sur SameSite) qui accepterait le cookie sur cross-site POST permettrait à un site malicieux de POST `/api/auth/refresh` (refresh légitime mais non-souhaité, fingerprinting timing) ou `/api/auth/logout` (DoS de session).
- **Impact**: faible (modèle de menace réaliste 2026 = SameSite fonctionne).
- **Mitigation**: dans chaque route handler cookie-authenticated:
  ```ts
  const origin = request.headers.get('origin');
  const allowed = new URL(request.url).origin;
  if (origin !== null && origin !== allowed) {
      return problemJson(403, { code: 'origin_mismatch', ... });
  }
  ```
- **Effort**: 30 min + tests vitest.

### S6-006 [LOW] [PROD-RISK] CSP `report-to` / `report-uri` non configurés en CI/staging

- **Catégorie**: observability
- **App**: les deux
- **Localisation**: `apps/{web,studio}/.env.local.example` — `NEXT_PUBLIC_CSP_REPORT_URI=` vide
- **Description**: l'infrastructure CSP-reporting est codée (`buildReportToHeader`, `report-uri` directive) mais aucune env. n'est provisionnée. Sans endpoint, les violations CSP en prod (notamment celles de S6-001) seront silencieuses → on ne saura pas qu'on casse l'UI prod tant qu'un user n'aura pas signalé.
- **Impact**: angle mort opérationnel.
- **Mitigation**: provisionner un endpoint (Cloudflare Worker reverse-proxy vers Sentry, ou `/api/csp-report`) puis renseigner `NEXT_PUBLIC_CSP_REPORT_URI` en staging et prod.
- **Effort**: 1-2 h (selon où on log).

### S6-007 [LOW] [PROD-RISK] Pas de SRI sur le script Cloudflare Turnstile

- **Catégorie**: SRI / supply-chain
- **App**: les deux
- **Localisation**: `apps/web/src/components/TurnstileWidget.tsx:107-115`, `apps/studio/src/components/TurnstileWidget.tsx:55-65`
- **Description**: le `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit">` est injecté en runtime sans `integrity=` ni `crossorigin=`. Cloudflare ne publie pas de hash stable (script CDN, mises à jour silencieuses) → SRI ne peut pas être appliqué de manière conservée.
- **Scénario d'attaque**: compromission de la CDN Cloudflare ou MitM (déjà bloqué par TLS+HSTS). Risque résiduel: trust-on-first-use sur le contenu du script.
- **Impact**: théorique. Dépend d'une compromission CF ou rupture TLS.
- **Mitigation**: à documenter comme accepted risk (l'industrie entière dans cet état). Surveiller le blog Cloudflare pour une éventuelle annonce de versionning hash-stable.
- **Effort**: 0 (acceptation explicite).

### S6-008 [LOW] [DEV-ONLY] CSP autorise `'unsafe-eval'` en mode `next dev`

- **Catégorie**: CSP enforcement
- **App**: les deux
- **Localisation**: `apps/web/src/lib/csp.ts:84-91`, `apps/studio/src/lib/csp.ts:38-39`
- **Description**: en dev, `script-src` inclut `'unsafe-eval'` car React 19 dev runtime + Turbopack chunk loader appellent `eval()` pour reconstruire les stack traces. La relaxation est correctement gardée par `dev === true` (bound à `process.env.NODE_ENV !== 'production'`). Vérifié à l'inspection: `pnpm start` (build prod) émet `script-src 'self' 'nonce-...' 'strict-dynamic' https://challenges.cloudflare.com` sans `'unsafe-eval'`.
- **Impact**: aucun en prod; risqué seulement si quelqu'un déploie accidentellement un build dev.
- **Mitigation**: aucune action — guard runtime correcte. Documenter dans le runbook deploy: `NODE_ENV=production` obligatoire.
- **Effort**: 0.

### S6-009 [INFO] Le forward de l'access token en clair via `Authorization` n'est pas un leak

- **Catégorie**: auth state
- **App**: les deux
- **Localisation**: `apps/web/src/lib/auth/AuthContext.tsx:217-222`, `apps/studio/src/lib/auth/AuthContext.tsx:189-194`
- **Description**: lors du `logout()`, l'access token est lu depuis le store et envoyé à `/api/auth/logout` via header `Authorization: Bearer …`. Le route handler le reforward à l'upstream pour invalider la family. Le token reste en mémoire et dans la requête HTTP same-origin (pas exposé cross-origin). Pas un finding — design intentionnel et correct.
- **Mitigation**: aucune.
- **Effort**: 0.

### S6-010 [INFO] [PROD-RISK indirect] Pas de validation magic-byte client sur l'upload avatar

- **Catégorie**: file upload
- **App**: web (`apps/web/src/app/me/ProfileForm.tsx:60-72`)
- **Description**: `accept="image/png, image/jpeg, image/webp"` est purement déclaratif (browser hint). L'utilisateur peut soumettre n'importe quel fichier renommé en `.png`. La taille est cappée à 256 KiB (`AVATAR_MAX_BYTES`), pas de SVG (donc pas de XSS via SVG `<script>`). Le payload final est une `data:` URL embarquée dans le PATCH JSON, encadrée par `UpdateProfileRequestSchema` (Zod `.url()`). La validation de signature MIME (magic bytes) doit avoir lieu côté API gateway — hors périmètre de cet audit.
- **Impact**: aucun XSS direct (data URL `<img>`, pas exécuté). Risque de bytes arbitraires stockés en DB tant que l'API gateway ne valide pas magic-bytes.
- **Mitigation**: vérifier dans l'audit S5/API que `POST /v1/members/me` valide les magic bytes des `data:` URLs avant écriture. Pas d'action frontend.
- **Effort**: 0 (côté frontend).

### S6-011 [INFO] React JSX échappe le user-content rendu — confirmation

- **Catégorie**: stored XSS
- **App**: les deux
- **Localisation**: `apps/web/src/app/classes/ClassCard.tsx:66`, `apps/studio/src/app/dashboard/classes/ClassesAdminList.tsx:215`, `apps/web/src/app/me/ProfileForm.tsx`, `apps/web/src/app/me/ProfileSection.tsx`
- **Description**: tous les champs user-suppliés (`class.title`, `class.coachName`, `displayName`, `email`, `studio.name`, `studio.brandLogo`) sont rendus via `{value}` dans JSX → React échappe automatiquement HTML entities. Aucun usage de `dangerouslySetInnerHTML` dans le code applicatif.
  - `brandColor` de `BrandingPreview` est doublement validé: client `^#[0-9A-Fa-f]{6}$/u` (`BrandingPreview.tsx:79`) ET server-side WCAG AA contrast check. Injection CSS via `style={{ backgroundColor }}` reste possible _en théorie_ avec un payload comme `red; }/* … */` mais la regex le rejette.
  - `studio.brandLogo` est un URL string qui pourrait théoriquement être une `javascript:` URL si rendu via `<a href={brandLogo}>` — mais aucune ref dans le code aujourd'hui (le champ semble préparé pour une future feature).
- **Mitigation**: aucune action immédiate. Quand `brandLogo` sera consommé, valider explicitement `https://...` dans le schéma Zod (`UrlSchema.refine(u => u.startsWith('https://'))`) — surface offset pour l'audit S5 ou la slice qui ajoutera le rendu.
- **Effort**: 0 aujourd'hui; 15 min lors du wiring brandLogo.

---

## Annexes

### A. Commandes de reproduction des tests headers

```powershell
pnpm --filter @athlya/web    dev   # port 3000 (terminal A)
pnpm --filter @athlya/studio dev   # port 3001 (terminal B)
curl.exe -sI http://localhost:3000/
curl.exe -sI http://localhost:3001/
```

### B. Recherches effectuées (ripgrep) — récapitulatif

| Pattern                                         | Hits applicatifs                                               | Note                                                                            |
| ----------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `dangerouslySetInnerHTML`                       | 0 dans `apps/{web,studio}/src/**`                              | matches dans `.next/dev/**` = framework                                         |
| `innerHTML\s*=`                                 | 0 dans `apps/{web,studio}/src/**`                              | idem                                                                            |
| `eval\(`                                        | 0 dans `apps/{web,studio}/src/**` (sauf commentaires `csp.ts`) | idem                                                                            |
| `new Function\(`                                | 0 dans `apps/{web,studio}/src/**`                              | idem                                                                            |
| `setTimeout\('…'`                               | 0                                                              | —                                                                               |
| `location\.hash`                                | 0                                                              | —                                                                               |
| `localStorage` / `sessionStorage` / `indexedDB` | 0 setItem/open dans le code                                    | seules occurrences = commentaires de `token-store.ts` qui _interdisent_ l'usage |
| `useSearchParams` / `searchParams.get`          | 0                                                              | aucun open redirect possible                                                    |
| `next/script`                                   | 0                                                              | tous les scripts sont injectés à la main avec nonce (`TurnstileWidget`)         |
| `Permissions-Policy`                            | 0                                                              | confirmé absent                                                                 |
| `productionBrowserSourceMaps`                   | 0                                                              | défaut Next = false ⇒ pas de maps en prod                                       |
| `<script>` / `<style>` JSX inline               | 0                                                              | aucun bloc inline applicatif                                                    |
| `style={{` JSX inline                           | 2 (BrandingPreview)                                            | voir S6-001                                                                     |

### C. Score détaillé (sur 100)

| Axe                                           | Pondération | Score                                 |
| --------------------------------------------- | ----------- | ------------------------------------- |
| XSS (R/S/DOM)                                 | 20          | 20                                    |
| CSP nonce-strict                              | 15          | 12 (–3 S6-001)                        |
| Auth storage (token in mem + httpOnly cookie) | 15          | 15                                    |
| CSRF (SameSite=Lax + httpOnly)                | 10          | 9 (–1 S6-005)                         |
| Headers HTTP statiques                        | 10          | 6 (–2 S6-002 –1 S6-003 –1 S6-004)     |
| Open redirect / form action                   | 5           | 5                                     |
| File upload safety                            | 5           | 4 (–1 S6-010 informational)           |
| Form security (autocomplete, password type)   | 5           | 5                                     |
| Source map / build hardening                  | 5           | 5                                     |
| Reporting / observability CSP                 | 5           | 3 (–2 S6-006)                         |
| SRI / supply chain                            | 5           | 3 (–2 S6-007 acceptable mais visible) |
| **Total**                                     | **100**     | **82**                                |

### D. Pour aller plus loin (post-S6, hors périmètre)

- **Trusted Types** (`require-trusted-types-for 'script'`): blocage `eval`/`innerHTML` pris en charge par les browsers Chromium. Pourrait être ajouté en `report-only` puis enforce après stabilisation. Effort ~ 2-3 j.
- **CSP Reporting endpoint dédié**: implémenter le route handler `POST /api/csp-report` qui filtre + forward vers Sentry, plutôt que de pointer Sentry directement (évite la fuite de versions packages dans le payload `script-sample`).
- **Subresource hardening Turnstile**: alternative à SRI — proxifier le script Turnstile via un Worker Cloudflare `/_/turnstile.js` et appliquer un cache/audit d'intégrité côté serveur. Coût opérationnel non négligeable.
- **Audit ZAP baseline en CI**: le job `.github/workflows/zap-baseline.yml` existe déjà — vérifier qu'il scan les deux apps et pas seulement `web`.
