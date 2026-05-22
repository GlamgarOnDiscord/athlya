# ESLint Plugins — Framework Audit

_Last updated: 2026-05-23_

## Versions

| Plugin                            | Version | Latest     | Purpose                                 |
| --------------------------------- | ------- | ---------- | --------------------------------------- |
| @eslint/js                        | ^9.39.1 | 10.3.0     | Core ESLint recommended rules           |
| typescript-eslint                 | ^8.50.0 | **8.59.3** | TypeScript-aware linting                |
| eslint-plugin-import              | ^2.32.0 | 2.32.0     | Import ordering + no duplicates         |
| eslint-plugin-unused-imports      | ^4.2.0  | 4.2.0      | Dead import removal                     |
| eslint-plugin-react               | ^7.37.5 | 7.37.5     | React-specific rules                    |
| eslint-plugin-react-hooks         | ^7.0.0  | 7.0.0      | Hooks rules (exhaustive deps)           |
| eslint-config-prettier            | ^10.1.8 | 10.1.8     | Disable rules conflicting with Prettier |
| globals                           | ^17.0.0 | 17.0.0     | Environment global declarations         |
| eslint-import-resolver-typescript | ^4.4.4  | 4.4.4      | TS path resolution for import plugin    |

---

## Action Required: ESLint 10 Compatibility

When upgrading ESLint to v10 (see `eslint.md`), verify plugin compatibility:

| Plugin                            | ESLint 10 Compatible? | Action                  |
| --------------------------------- | --------------------- | ----------------------- |
| typescript-eslint ^8.59           | Yes                   | Upgrade `^8.50 → ^8.59` |
| eslint-plugin-import ^2.32        | Yes (peer allows v10) | No change               |
| eslint-plugin-unused-imports ^4.2 | Yes                   | No change               |
| eslint-plugin-react ^7.37         | Yes                   | No change               |
| eslint-plugin-react-hooks ^7.0    | Yes                   | No change               |
| eslint-config-prettier ^10.1      | Yes                   | No change               |

**Upgrade `typescript-eslint` now** (independent of ESLint upgrade):

```bash
pnpm add -D typescript-eslint@^8.59 -w
```

No breaking changes from 8.50 to 8.59. Includes:

- Fix: crash in `no-unsafe-type-assertion` on recursive templates
- Improvements to `no-deprecated` rule
- Better inference for `no-misused-promises`

---

## Assessment

### Rule Configuration Highlights

| Rule                               | Setting                  | Why                                         |
| ---------------------------------- | ------------------------ | ------------------------------------------- |
| `consistent-type-imports`          | error, separate          | Tree-shaking, `verbatimModuleSyntax` compat |
| `no-misused-promises`              | error (void attrs false) | Prevents async bugs in JSX props            |
| `unused-imports/no-unused-imports` | error                    | Prevents dead code accumulation             |
| `import/order`                     | warn, alphabetize        | Consistent import structure                 |
| `import/no-duplicates`             | error                    | Prevents double-imports                     |

### Type-Checked Rules

Using `recommendedTypeChecked` with `projectService: true` (modern approach — replaces deprecated `project: true`). Correct.

Config files (`*.config.{ts,js}`) disable type-checked rules via `tseslint.configs.disableTypeChecked` to prevent false positives on files outside tsconfig scope. Correct.

---

## Opportunity: `strict-type-checked` Preset

The project uses `recommendedTypeChecked`. The `strictTypeChecked` preset adds:

| Added Rule                   | What it catches                       |
| ---------------------------- | ------------------------------------- |
| `no-unnecessary-condition`   | Conditions that are always true/false |
| `no-unsafe-assignment`       | Variables typed as `any`              |
| `no-unsafe-call`             | Calling `any`-typed functions         |
| `no-unsafe-member-access`    | Accessing properties on `any`         |
| `strict-boolean-expressions` | Non-boolean values in boolean context |

Migration: Enable new rules as `warn` first, then promote to `error` after fixing violations.

---

## React Hooks Plugin — Verify Activation

`eslint-plugin-react-hooks: ^7.0.0` is in devDependencies. Verify it is explicitly configured in `packages/eslint-config/src/react.js`:

```js
// packages/eslint-config/src/react.js
import reactHooks from 'eslint-plugin-react-hooks';

export const config = [
  ...baseConfig,
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
];
```

If the plugin is imported but not in `plugins: {}`, `exhaustive-deps` is silently not enforced.

---

## Checklist

- [x] Flat config (ESLint 9)
- [x] Type-checked rules via `recommendedTypeChecked`
- [x] `projectService: true` (modern TS project detection)
- [x] Type imports consistently enforced
- [x] Unused imports auto-detected
- [x] Import ordering enforced
- [x] Prettier conflict prevention (config-prettier last)
- [ ] **Upgrade typescript-eslint `^8.50 → ^8.59`**
- [ ] **Migrate to ESLint 10 (see eslint.md)**
- [ ] Verify react-hooks plugin is in `plugins: {}` in react.js config
- [ ] Evaluate `strict-type-checked` preset (enable as warn first)

## Sources

- https://typescript-eslint.io/
- https://github.com/import-js/eslint-plugin-import
- https://github.com/sweepline/eslint-plugin-unused-imports
- https://github.com/facebook/react/tree/main/packages/eslint-plugin-react-hooks
