# Next.js 16 — Framework Audit

_Last updated: 2026-05-14_

## Version Status

|                       | Value                      |
| --------------------- | -------------------------- |
| **Utilisé**           | ^16.2.6                    |
| **Latest**            | 16.2.6 (dernière)          |
| **React**             | ^19.2.0                    |
| **Node.js requis**    | 20.9.0+ (Node 18 supprimé) |
| **TypeScript requis** | 5.1.0+                     |

---

## SECURITY — Mai 2026 (action requise)

Next.js a publié un patch de sécurité majeur en mai 2026 couvrant **13 vulnérabilités** combinées React + Next.js :

- DoS via crafted payloads
- SSRF via Server Actions
- Cache poisoning
- XSS via headers mal-sanitisés
- Bypass middleware d'authentification

**Action** : vérifier que `next` dans le lockfile résout à 16.2.6 minimum. Cette version inclut les correctifs.

```bash
pnpm why next   # doit afficher 16.2.6+
```

---

## Nouveautés Next.js 16.2

### Performance mesurée

| Métrique                          | Amélioration |
| --------------------------------- | ------------ |
| Démarrage dev                     | +400%        |
| Rendu                             | +50%         |
| Désérialisation Server Components | +350%        |

### Cache Components — Stable (plus expérimental)

Le modèle de cache déclaratif est désormais stable :

```ts
// next.config.ts
export default {
  cacheComponents: true, // active PPR (Partial Prerendering)
};
```

```tsx
// Server Component avec cache déclaratif
'use cache';
import { cacheLife } from 'next/cache';

export default async function ClassSchedulePage() {
  cacheLife('hours'); // ou 'days', 'weeks', 'infinity'
  const classes = await fetchClasses();
  return <ClassList classes={classes} />;
}
```

Invalider le cache :

```ts
import { revalidateTag, updateTag } from 'next/cache';

// Revalider après mutation
await revalidateTag('classes');

// Remplacer un tag
updateTag('classes', 'classes-studio-abc');
```

Usage Athlya :

- Pages publiques (landing) : `cacheLife('days')`
- Planning des cours par studio : `cacheLife('hours')` + `revalidateTag` après création/modification

### React 19.2 intégré

- `<ViewTransition>` pour animations de navigation entre routes
- `<Activity>` pour panels hors-écran
- `useEffectEvent` disponible
- `cacheSignal()` dans Server Components

### Next.js DevTools MCP

```bash
next dev --mcp   # expose un serveur MCP pour les outils AI
```

Permet l'introspection du build, des routes, des Server Components par des agents AI (Claude Code, Cursor, etc.).

### Turbopack — Stable et défaut

Turbopack est désormais le bundler de production **stable et par défaut** (plus expérimental) :

- 2-5x plus rapide que webpack
- 10x plus rapide pour Fast Refresh
- SRI (Subresource Integrity) support

---

## Changements Next.js 15 → 16

### Async params/searchParams (BREAKING depuis v15)

Les props `params` et `searchParams` sont maintenant des Promises :

```tsx
// AVANT (Next.js 14)
export default function Page({ params }: { params: { id: string } }) {
  return <div>{params.id}</div>;
}

// APRÈS (Next.js 15+, 16)
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <div>{id}</div>;
}
```

Le projet utilise le pattern correct avec `await params`.

### `proxy.ts` remplace `middleware.ts`

Le projet est déjà migré ✓

### `parallel routes` — `default.js` requis

Les parallel routes (`@folder`) nécessitent un fichier `default.js` explicite pour le rendu par défaut.

### `next lint` supprimé

La commande `next lint` est supprimée. Utiliser ESLint directement :

```json
// package.json — apps/web
{ "lint": "eslint src --ext .ts,.tsx" }
```

---

## Patterns appliqués correctement

### CSP Nonce via proxy.ts

Génération par `crypto.getRandomValues()` (128-bit), passage via `x-nonce` header. Pattern recommandé.

### Locale via `x-locale` header

Cookie > Accept-Language > défaut (fr). Séparation des responsabilités propre.

### Headers statiques dans next.config.ts

CSP dynamique dans le proxy, headers statiques dans la config. Correct.

### `transpilePackages`

```ts
transpilePackages: ['@athlya/shared'];
```

Requis pour les packages workspace qui exportent du TypeScript brut.

---

## Dépréciations Next.js 16

| Déprécié                     | Remplacement               | Statut projet         |
| ---------------------------- | -------------------------- | --------------------- |
| `middleware.ts`              | `proxy.ts`                 | ✓ migré               |
| `images.domains`             | `images.remotePatterns`    | Vérifier              |
| `revalidateTag(tag)` (1 arg) | `revalidateTag(tag, type)` | Vérifier              |
| `unstable_cache`             | `'use cache'` directive    | Non utilisé ✓         |
| `next/legacy/image`          | `next/image`               | Non utilisé ✓         |
| Pages Router                 | App Router                 | Non utilisé ✓         |
| `next lint`                  | `eslint` direct            | Mettre à jour scripts |
| AMP                          | Supprimé                   | Non utilisé ✓         |

---

## Fonctionnalités disponibles non encore utilisées

### Data Access Layer (DAL) avec `server-only`

```ts
import 'server-only';

export async function getMember(userId: string) {
  // auth check + fetch + DTO (pas la row brute)
}
```

Guard contre l'import accidentel de code serveur côté client.

### Hono RPC → client typé (alternative à createApiClient)

Via Hono RPC + `import type { AppRoutes }` — voir `hono.md`.

---

## Checklist

- [x] App Router (pas Pages Router)
- [x] `proxy.ts` (pas `middleware.ts`)
- [x] `await headers()` / `await cookies()`
- [x] CSP avec nonce par requête
- [x] Turbopack configuré
- [x] React 19 async Server Components
- [x] `transpilePackages` pour deps workspace
- [x] `loading.tsx` + `error.tsx` présents
- [ ] **Vérifier lockfile → Next.js 16.2.6 (patch sécurité mai 2026)**
- [ ] Activer `cacheComponents: true` pour PPR sur pages publiques
- [ ] Activer `'use cache'` + `cacheLife()` sur le planning de cours
- [ ] Migrer `next lint` vers `eslint` direct dans scripts
- [ ] Ajouter `server-only` sur les modules server-side utilities
- [ ] Ajouter route-level `metadata` exports sur les pages enfants
- [ ] Vérifier `images.domains` → `remotePatterns`

## Sources

- https://nextjs.org/blog/next-16
- https://nextjs.org/blog/next-16-2
- https://nextjs.org/docs/app/guides/upgrading/version-16
- https://nextjs.org/docs/app/getting-started/caching
- https://vercel.com/changelog/next-js-may-2026-security-release
