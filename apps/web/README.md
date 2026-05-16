# @athlya/web

Application web orientée membres pour la plateforme Athlya.

## Stack

- **Next.js 16** (App Router, Turbopack)
- **React 19**
- **Tailwind 4** (CSS-first via `@tailwindcss/postcss`)
- **TypeScript 5.9**

> **Note sur la résolution des versions.** La tâche 10.1 a épinglé ces dépendances aux dernières versions stables publiées sur le registry au moment du scaffolding (`next@^16.2.6`, `react@^19.2.0`, `tailwindcss@^4.3.0`, `eslint-config-next@^16.2.6`). Lors de la régénération du `pnpm-lock.yaml`, mettre à jour ces pins ici.

## Commandes

```bash
pnpm --filter @athlya/web dev        # serveur de dev local
pnpm --filter @athlya/web build      # build de production
pnpm --filter @athlya/web test       # vitest
pnpm --filter @athlya/web typecheck  # tsc --noEmit
pnpm --filter @athlya/web lint       # next lint
```

## Scaffolding sécurité (tâche 10.1)

Toutes les réponses HTML sont servies avec :

- `X-Frame-Options: DENY` (Req 25.4) — statique, déclaré dans `next.config.ts`.
- `Referrer-Policy: strict-origin` (Req 25.4) — statique, déclaré dans `next.config.ts`.
- `X-Content-Type-Options: nosniff` — défense en profondeur, statique.
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` (Req 25.2) — statique.
- `Content-Security-Policy` (Req 25.3) — **nonce par requête**, généré dans `src/proxy.ts`
  (le remplaçant Next.js 16 du fichier `middleware.ts`) et propagé dans l'en-tête CSP
  de la réponse ainsi que dans le header `x-nonce` pour que les Server Components
  puissent réutiliser le nonce pour les balises `<style>` / `<script>` inline.

La CSP autorise `https://challenges.cloudflare.com` en avance afin que la tâche 10.2
puisse intégrer le widget Cloudflare Turnstile sans modifier la politique.

### Écart par rapport au brief de la tâche

La description de la tâche mentionne un preset Tailwind partagé dans
`packages/config/tailwind/web.ts`. Tailwind 4 a abandonné le modèle de preset JS/TS
en faveur de `@import "tailwindcss"` + `@theme { ... }` en CSS, le preset partagé
n'est donc plus nécessaire. Les tokens sémantiques équivalents sont importés depuis
`@athlya/shared/tokens` et projetés dans `src/styles/tokens.css` en tant que
propriétés CSS custom. Si Tailwind 4 réintroduit le support des presets, on pourra
ré-extraire le snapshot dans un package partagé.

La description de la tâche s'articule aussi bien avec le helper `buildBrandColorCss`
de la tâche 15.2 dans `@athlya/shared/theming`. L'intégration directe a été mise
hors scope de la 10.1 car le resolver de Turbopack trébuche sur l'import relatif
non buildé `./brand-color.js` du package partagé (résolution `moduleResolution` mode
bundler sur des fichiers `.ts` bruts). Le snapshot `tokens.css` expose déjà les
valeurs par défaut de `--athlya-brand-primary`, et le resolver de tenant de la tâche
15.1 les écrasera au moment de la requête — à ce stade on pourra réintroduire
`buildBrandColorCss` une fois le package partagé buildé en amont de l'app web via
une arête `dependsOn` Turborepo.

## Structure des répertoires

```
apps/web/
├── next.config.ts            # en-têtes de sécurité statiques + transpilePackages
├── postcss.config.mjs        # @tailwindcss/postcss
├── tsconfig.json             # extends @athlya/tsconfig/next.json
├── vitest.config.ts          # environnement node, tests sous src/
├── public/                   # assets statiques
└── src/
    ├── app/
    │   ├── globals.css       # @import "tailwindcss" + extension @theme
    │   ├── layout.tsx        # coquille HTML racine + CSS de marque par tenant
    │   ├── not-found.tsx     # page 404
    │   └── page.tsx          # page d'accueil
    ├── lib/
    │   ├── csp.ts            # generateCsp({ nonce, apiUrl })
    │   ├── env.ts            # accès typé aux variables d'environnement publiques
    │   └── nonce.ts          # générateur de nonce base64url 128 bits
    ├── proxy.ts              # proxy edge — CSP par requête + header x-nonce
    └── styles/
        └── tokens.css        # propriétés CSS custom miroir de tokens.ts
```

## Traçabilité des exigences

- **Req 25.3** — CSP stricte avec nonces par requête (`src/proxy.ts`, `src/lib/csp.ts`).
- **Req 25.4** — `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin` (`next.config.ts`).
- **Req 27.1, 27.2** — Audit axe WCAG 2.2 AA + budget Lighthouse accessibilité (`e2e/`, `scripts/lighthouse-check.js`, `.github/workflows/axe.yml`).

## Accessibilité (tâche 10.7)

La cible d'accessibilité d'Athlya est **WCAG 2.2 AA** sur chaque page orientée membre,
et **score Lighthouse Accessibilité ≥ 95** sur les points d'entrée publics.
Deux couches automatisées gardent cet objectif :

1. **Audit axe-core** (`@axe-core/playwright`) — s'exécute sous un vrai Chromium
   headless contre `/`, `/login`, `/register`, `/classes`, `/me`, `/me/export`,
   `/me/delete`. Les pages authentifiées utilisent une fixture qui stubifie
   `/api/auth/login` + les lectures en aval pour que l'audit n'exerce que le DOM rendu.
2. **Budget Lighthouse** — vérifie que le score Accessibilité est ≥ 95 sur `/`,
   `/login`, `/register`.

### Exécution locale

```bash
# Une fois : installer un Chromium headless pour Playwright.
pnpm --filter @athlya/web e2e:install

# Lancer l'audit axe. Playwright démarre automatiquement le serveur Next.js
# via sa config `webServer` (ou réutilise celui déjà démarré sur :3000).
pnpm --filter @athlya/web e2e

# Lancer le budget Lighthouse. Nécessite un serveur dev ou prod sur :3000.
pnpm --filter @athlya/web dev &      # ou pnpm build && pnpm start
pnpm --filter @athlya/web lighthouse
```

### CI

`.github/workflows/axe.yml` exécute l'audit axe et le budget Lighthouse sur chaque
pull request qui touche `apps/web/**`, `packages/shared/**`, ou le fichier de workflow
lui-même. Le workflow utilise le même Chromium téléchargé par `e2e:install`, aucune
étape d'installation de navigateur séparée n'est requise pour Lighthouse.

> **Note.** La suite e2e est intentionnellement isolée sous `apps/web/e2e/` et ne fait
> **pas** partie de `pnpm --filter @athlya/web test` (Vitest). Vitest correspond à
> `src/**/*.test.{ts,tsx}`, donc `e2e/**` est exclu naturellement. Lancer `pnpm e2e`
> localement nécessite un vrai Chromium et échouera dans les sandboxes headless sans
> en avoir un.
