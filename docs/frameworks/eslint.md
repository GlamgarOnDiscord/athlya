# ESLint — Framework Audit

*Last updated: 2026-05-14*

## Version Status

| | Value |
|---|---|
| **Utilisé** | ^9.39.1 |
| **Dernière stable** | **10.3.0** (1er mai 2026) |
| **ESLint 9 EOL** | **6 août 2026** (~3 mois) |
| **typescript-eslint** | ^8.50.0 → latest 8.59.3 |
| **Action urgente** | Migrer vers v10 avant août 2026 |

---

## URGENT — ESLint 10 et suppression de eslintrc

### ESLint 10 : eslintrc entièrement supprimé

- ESLint 9 avait déprécié le format eslintrc
- **ESLint 10 le supprime définitivement** — seul le flat config (`eslint.config.js`) est supporté
- **ESLint 9 entre en fin de vie le 6 août 2026**

### Impact critique : `apps/web/.eslintrc.json`

Le projet a un `.eslintrc.json` legacy dans `apps/web/` qui coexiste avec le flat config racine.

**Ce fichier doit être migré avant août 2026.**

**Migration recommandée** :

```js
// apps/web/eslint.config.js (à créer)
import { config as athlyaConfig } from '@athlya/eslint-config/react';
import nextPlugin from '@next/eslint-plugin-next';

export default [
    ...athlyaConfig,
    {
        plugins: { '@next/next': nextPlugin },
        rules: {
            ...nextPlugin.configs.recommended.rules,
            ...nextPlugin.configs['core-web-vitals'].rules,
        },
    },
];
```

Puis supprimer `apps/web/.eslintrc.json`.

**Note** : vérifier que `eslint-config-next` ^16 exporte un config flat avant de migrer. Si pas encore disponible, ouvrir un issue sur le dépôt `vercel/next.js`.

---

## Configuration actuelle — Évaluation

### Root Config

Import de `@athlya/eslint-config` avec ignores globaux. Pattern correct pour monorepo.

### Shared Config (`@athlya/eslint-config`)

```js
export const config = [
    { ignores: [...] },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    { languageOptions: { ... }, plugins: { ... }, rules: { ... } },
    { files: ['**/*.{js,cjs,mjs}'], ...tseslint.configs.disableTypeChecked },
    eslintConfigPrettier,
];
```

### Règles clés

| Règle | Réglage | Évaluation |
|---|---|---|
| `consistent-type-imports` | error (separate) | ✓ optimal pour tree-shaking |
| `unused-imports/no-unused-imports` | error | ✓ |
| `unused-imports/no-unused-vars` | warn (underscore) | ✓ |
| `import/order` | warn (alphabetize) | ✓ |
| `import/no-duplicates` | error | ✓ |
| `no-misused-promises` | error (void attrs false) | ✓ prévient les bugs async |

### Type-Checked Rules

Utilise `recommendedTypeChecked` avec `projectService: true`. Pattern moderne (remplace l'ancien `project: true`).

---

## ESLint 10 — Nouveautés

### Flat config uniquement

```js
// ESLint 10 : seule façon valide
import js from '@eslint/js';
export default [js.configs.recommended, ...];
```

### `meta.languages` — règles language-aware (10.2.0)

Les plugins peuvent maintenant déclarer pour quels langages une règle s'applique :

```js
{
    meta: {
        languages: ['javascript', 'typescript'],
    }
}
```

### `no-unused-private-class-members` — suggestions de suppression

La règle propose maintenant des corrections automatiques (suggestions) pour les membres privés inutilisés.

---

## typescript-eslint 8.59.3

Dernière version stable. Releases récentes :
- 8.59.2 : fix crash `no-unsafe-type-assertion` sur templates récursifs, améliorations `no-deprecated`
- Pas de breaking changes depuis 8.50.0

### Opportunité : preset `strict-type-checked`

Le projet utilise `recommendedTypeChecked`. Le preset `strictTypeChecked` est plus strict et ajoute :
- `no-unnecessary-condition` — conditions toujours true/false
- `no-unsafe-*` — usage de `any` non contrôlé
- `strict-boolean-expressions` — expressions booléennes non-standard

Migration en deux temps : activer les nouvelles règles en `warn` d'abord.

---

## Problèmes identifiés

### 1. Coexistence `.eslintrc.json` + flat config (URGENT)

- `apps/web/.eslintrc.json` = format legacy
- Root `eslint.config.js` = flat config
- ESLint 10 ne supportera plus `.eslintrc.*`
- **Délai : 3 mois avant EOL ESLint 9**

### 2. `eslint-plugin-react-hooks` — vérifier activation

`eslint-plugin-react-hooks: ^5.2.0` est en dépendance mais sa configuration doit être vérifiée dans `packages/eslint-config/src/react.js`.

### 3. Absence de `eslint-plugin-security`

Optionnel mais utile pour détecter des patterns dangereux (eval, regex DoS, injection). Faible priorité vu l'architecture security-first.

---

## Plan de migration ESLint 9 → 10

1. `pnpm add -D eslint@^10 -w`
2. Vérifier que `@athlya/eslint-config` est compatible ESLint 10 (peer deps)
3. Migrer `apps/web/.eslintrc.json` → `apps/web/eslint.config.js`
4. Vérifier que `eslint-config-next` ^16 supporte flat config
5. Supprimer `.eslintrc.json`
6. Tester : `pnpm lint`

---

## Checklist

- [x] ESLint 9 flat config
- [x] Type-checked rules activées
- [x] Type imports consistants enforced
- [x] Unused imports auto-détectés
- [x] Import ordering enforced
- [x] Prettier conflict prevention (config-prettier en dernier)
- [ ] **Migrer apps/web/.eslintrc.json vers flat config (EOL août 2026)**
- [ ] **Upgrader ESLint ^9 → ^10**
- [ ] Vérifier activation react-hooks plugin pour apps/web
- [ ] Évaluer `strict-type-checked` preset (remplace `recommended`)
- [ ] Mettre à jour typescript-eslint ^8.50 → ^8.59

## Sources

- https://eslint.org/docs/latest/use/configure/configuration-files
- https://eslint.org/blog/2026/05/eslint-v10.3.0-released/
- https://typescript-eslint.io/getting-started/typed-linting/
- https://nextjs.org/docs/app/api-reference/config/eslint
