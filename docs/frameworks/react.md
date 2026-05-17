# React 19 — Framework Audit

_Last updated: 2026-05-14_

## Version Status

|                   | Value   |
| ----------------- | ------- |
| **Used**          | ^19.2.0 |
| **Latest secure** | 19.2.6  |
| **react-dom**     | ^19.2.0 |

---

## SECURITY — Patches critiques (action requise)

React 19.x a subi trois CVE critiques corrigées à partir de 19.2.1. **Vérifier que le lockfile résout React à 19.2.6 minimum.**

```bash
pnpm why react   # doit afficher 19.2.6 ou supérieur
```

| CVE            | CVSS              | Description                                               | Corrigé dans             |
| -------------- | ----------------- | --------------------------------------------------------- | ------------------------ |
| CVE-2025-55182 | **10.0 Critical** | RCE via décodage de payload Server Components malveillant | 19.0.6 / 19.1.7 / 19.2.1 |
| CVE-2025-55184 | 7.5 High          | DoS via payload forgé                                     | 19.0.6 / 19.1.7 / 19.2.1 |
| CVE-2025-55183 | 5.3 Medium        | Exposition de code source (fuite d'API keys/secrets)      | 19.0.6 / 19.1.7 / 19.2.1 |

---

## Fonctionnalités React 19 utilisées correctement

### Async Server Components

```tsx
export default async function HomePage(): Promise<ReactElement> { ... }
```

Pattern correct pour Next.js 16 App Router.

### `'use client'` boundaries

Utilisé correctement sur `AuthContext.tsx`, `LocaleSwitcher.tsx`, `TurnstileWidget.tsx`.

### `useCallback` / `useMemo` pour la stabilité référentielle

Correct. Patterns `useCallback([], [])` sur `login`/`logout` appropriés.

---

## React 19.2 — Nouveaux APIs (octobre 2025)

### `useEffectEvent` Hook

Extrait la logique non-réactive hors des Effects, empêche les re-runs inutiles :

```tsx
import { useEffectEvent } from 'react';

function ChatRoom({ onMessage }) {
  const handleMessage = useEffectEvent(onMessage); // non-réactif
  useEffect(() => {
    socket.on('message', handleMessage);
    return () => socket.off('message', handleMessage);
  }, []); // onMessage n'est pas une dépendance
}
```

**Usage potentiel dans Athlya** : effet de refresh du token d'accès dans `AuthContext.tsx`.

### `<Activity />` — Composant de visibilité

Contrôle la visibilité avec des mises à jour différées :

```tsx
import { Activity } from 'react';

<Activity mode={isDrawerOpen ? 'visible' : 'hidden'}>
  <ExpensivePanel />
</Activity>;
```

- `hidden` : effects démontés, state préservé, updates différés
- `visible` : rendu normal
- Usage Athlya : panels off-screen, onglets arrière-plan

### `<ViewTransition />` — Animations natives

Anime les changements de DOM via la Web Animations API (intégré avec Next.js 16) :

```tsx
import { ViewTransition } from 'react';

<ViewTransition>
  <ClassCard key={classId} />
</ViewTransition>;
```

### `cacheSignal()` — Server Components uniquement

Donne accès au signal d'expiration du cache dans un Server Component :

```tsx
import { cacheSignal } from 'react';
async function ServerComponent() {
  const signal = cacheSignal();
  const data = await fetch(url, { signal });
  return <div>{data}</div>;
}
```

---

## Problèmes identifiés

### 1. AuthContext — pattern `useState + useEffect` sur un store externe (RISQUE)

`AuthContext.tsx` synchronise `token-store.ts` via `useState + useEffect`. Ce pattern peut causer du **tearing** sous le mode concurrent de React 19.

**Correction** — utiliser `useSyncExternalStore` :

```tsx
import { useSyncExternalStore } from 'react';

const accessToken = useSyncExternalStore(
  subscribeToAccessToken, // subscribe
  getAccessToken, // getSnapshot
  () => null, // getServerSnapshot
);
```

`subscribeToAccessToken` et `getAccessToken` existent déjà dans `token-store.ts` — refactoring minimal.

### 2. Pas de boundaries `<Suspense>`

Requis pour :

- `use()` hook (lecture de contexte/promises)
- Cache Components (Next.js 16 PPR)
- Streaming de données Server → Client

Ajouter `<Suspense fallback={<Skeleton />}>` autour des consommateurs de données async.

### 3. Error boundaries client-side

`error.tsx` est présent au niveau des routes ✓. Ajouter un `<ErrorBoundary>` composant autour des sous-arbres dépendant de l'auth pour un logout gracieux sur expiration du token.

---

## Patterns dépréciés

| Pattern                                  | Remplacement             | Statut              |
| ---------------------------------------- | ------------------------ | ------------------- |
| `useState + useEffect` sur store externe | `useSyncExternalStore`   | Risque tearing      |
| Nettoyage manuel dans effects            | `useEffectEvent`         | Verbeux inutilement |
| `React.createFactory()`                  | JSX                      | Supprimé            |
| `defaultProps` sur function components   | Paramètres par défaut TS | Non utilisé ici     |

---

## Checklist

- [x] React 19.2.x avec Server Components
- [x] `'use client'` boundaries correctement placées
- [x] `useCallback`/`useMemo` pour la stabilité
- [x] `error.tsx` présent (route error boundaries)
- [x] `loading.tsx` présent (Suspense fallback)
- [ ] **Vérifier lockfile → React 19.2.6+ (CVE-2025-55182 CVSS 10.0)**
- [ ] Refactoriser `AuthContext` token store vers `useSyncExternalStore`
- [ ] Ajouter `<Suspense>` pour streaming et PPR
- [ ] Évaluer `useEffectEvent` pour le refresh token effect
- [ ] Évaluer `<ViewTransition>` pour la navigation de liste de cours
- [ ] Évaluer `<Activity>` pour les panels hors-écran

## Sources

- https://react.dev/blog/2025/10/01/react-19-2
- https://react.dev/blog/2025/12/03/critical-security-vulnerability-in-react-server-components
- https://react.dev/reference/react/useSyncExternalStore
- https://react.dev/reference/react/useEffectEvent
- https://react.dev/reference/react/Activity
