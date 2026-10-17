# TypeScript — Framework Audit

> **Archive snapshot — 2026-05-14.** Le projet est passé sur TypeScript `^6.0.3` (#574). TypeScript 7.0 (compilateur natif Go) est sorti depuis, mais sans API programmatique stable avant 7.1 et typescript-eslint plafonne à `<6.1` : la migration vers 7.x reste bloquée. Voir `STACK.md` pour l'état courant.

_Last updated: 2026-05-14_

## Version Status

|                     | Value                                                           |
| ------------------- | --------------------------------------------------------------- |
| **Utilisé**         | ^5.9.3                                                          |
| **Dernière stable** | voir registry — le tableau ci-dessus est un snapshot 2026-05-14 |
| **Action**          | Aucun — version actuelle supportée et stable                    |

---

## TypeScript 6.0 — Changements majeurs (mars 2026)

### Nouveaux défauts — impact sur le projet

| Option                         | TS 5.x défaut | TS 6.0 défaut                    | Statut projet                               |
| ------------------------------ | ------------- | -------------------------------- | ------------------------------------------- |
| `strict`                       | false         | **true**                         | ✓ déjà activé                               |
| `target`                       | ES3           | **ES2025**                       | ⚠ projet sur ES2022 → mettre à jour         |
| `module`                       | commonjs      | **ESNext**                       | ✓ déjà ESNext                               |
| `moduleResolution`             | node10        | **bundler**                      | ✓ déjà bundler                              |
| `rootDir`                      | auto          | **"."**                          | ✓ explicite                                 |
| `types`                        | auto-load all | **`[]`** (aucun auto-chargement) | ⚠ peut casser les @types implicites         |
| `noUncheckedSideEffectImports` | false         | **true**                         | ⚠ imports side-effect doivent être déclarés |

### Suppressions définitives (BREAKING)

Ces options/fonctionnalités **n'existent plus** en TS 6 :

| Supprimé                         | Statut projet        | Action              |
| -------------------------------- | -------------------- | ------------------- |
| Target ES3, ES5                  | Non utilisé ✓        | —                   |
| `--outFile`                      | Non utilisé ✓        | —                   |
| Modules AMD / UMD / SystemJS     | Non utilisés ✓       | —                   |
| `--moduleResolution classic`     | Non utilisé ✓        | —                   |
| `--moduleResolution node10`      | Non utilisé ✓        | —                   |
| `--baseUrl` sans `paths`         | Non utilisé ✓        | —                   |
| `/// <reference no-default-lib>` | Non utilisé ✓        | —                   |
| Import assertions (`assert {}`)  | Vérifier → `with {}` | Auditer les imports |

### Import assertions → Import attributes

```ts
// TS 5.x (assertions, SUPPRIMÉ)
import data from './data.json' assert { type: 'json' };

// TS 6.0+ (attributes, correct)
import data from './data.json' with { type: 'json' };
```

Auditer le codebase : `grep -r "assert {" --include="*.ts"`.

---

## Configuration actuelle — Évaluation

### Base Config (packages/tsconfig/base.json) — Excellente

```json
{
  "strict": true, // ✓ identique à TS 6 default
  "noUncheckedIndexedAccess": true, // ✓ bonne pratique
  "exactOptionalPropertyTypes": true, // ✓ très strict
  "noImplicitOverride": true, // ✓
  "noFallthroughCasesInSwitch": true, // ✓
  "noImplicitReturns": true, // ✓
  "verbatimModuleSyntax": true, // ✓
  "isolatedModules": true // ✓
}
```

**Recommandation TS 6 migration** : ajouter `"target": "ES2025"` et `"types": []` explicitement.

### `noUncheckedSideEffectImports` — Nouveau en TS 6

Ce flag (actif par défaut en TS 6) force à déclarer explicitement les imports side-effect :

```ts
// Avant (TS 5) : import CSS en side-effect, pas de type check
import './globals.css';

// TS 6 : vérifie que le fichier existe (résolution de module stricte)
import './globals.css'; // OK si le module est dans tsconfig include
```

Impact : vérifier que tous les imports side-effect (CSS, polyfills) sont correctement résolus.

### `erasableSyntaxOnly` — Flag optionnel (recommandé)

Disponible depuis TS 5.9, plus utile maintenant que TS 6 supprime enums/namespaces compilés :

```json
{ "erasableSyntaxOnly": true }
```

Empêche l'usage d'enums et namespaces non-erasables (qui émettent du JS). Le projet n'en utilise pas — ajouter le flag pour prévenir leur introduction.

---

## Problèmes identifiés

### 1. `Object.setPrototypeOf` dans les error classes (inutile depuis ES2022)

```ts
// Dans circuit-breaker.ts — legacy pattern pour ES5
Object.setPrototypeOf(this, new.target.prototype);
```

Avec `target: "ES2022"` et `useDefineForClassFields: true`, la chaîne de prototype est gérée nativement. **Supprimer ces appels.**

### 2. `target: "ES2022"` → mettre à jour en `"ES2025"`

TS 6.0 cible ES2025 par défaut. Aligner le projet :

```json
// packages/tsconfig/base.json
{ "target": "ES2025" }
```

ES2025 ajoute : `Array.fromAsync()`, `Promise.try()`, RegExp duplicate named groups, `import.meta.dirname/filename`.

### 3. `@types/node: ^20.19.9` — vérifier compatibilité Node 20 LTS

Correct pour le moteur `node >=20 <21`. Pas d'action nécessaire.

---

## TypeScript 7.0 — Ne pas utiliser en production

TypeScript 7.0 est en **beta** (avril 2026). C'est une réécriture complète en Go :

- 10x plus rapide que TS 6
- Parallélisation multi-thread
- Même système de types que TS 6 (compatibilité assurée)

**Stratégie** : attendre la GA avant d'envisager l'upgrade. La migration sera transparente en termes d'API.

---

## Plan de migration TS 5.9 → 6.0

1. `pnpm add -D typescript@^6`
2. Vérifier `"target": "ES2025"` dans base.json
3. Ajouter `"types": []` explicitement là où approprié (évite les surprises)
4. Auditer les import assertions : `grep -r "assert {" --include="*.ts"`
5. Supprimer les `Object.setPrototypeOf` dans les error classes
6. Ajouter `"erasableSyntaxOnly": true`
7. Lancer `pnpm typecheck` — corriger les erreurs residuelles
8. Vérifier que `noUncheckedSideEffectImports` ne bloque pas d'imports CSS/polyfills

---

## Checklist

- [x] Configuration strict maximale
- [x] `verbatimModuleSyntax` + type imports consistants
- [x] Extensions `.js` sur les imports internes
- [x] Stratégie dual-module (bundler apps, NodeNext packages)
- [x] `as const` pour les literal types
- [ ] **Migrer vers TypeScript 6.0** (7 étapes ci-dessus)
- [ ] `target: "ES2025"` (était ES2022)
- [ ] Supprimer `Object.setPrototypeOf` dans les error classes
- [ ] Ajouter `erasableSyntaxOnly: true`
- [ ] Auditer les import assertions (`assert` → `with`)
- [ ] Évaluer `using` / `await using` pour les connexions DB

## Sources

- https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html
- https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-9.html
- https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/
- https://www.typescriptlang.org/tsconfig
