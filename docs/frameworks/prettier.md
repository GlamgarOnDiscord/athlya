# Prettier — Framework Audit

## Version Status

|                    | Value                               |
| ------------------ | ----------------------------------- |
| **Used**           | ^3.8.3                              |
| **Config package** | @athlya/prettier-config (workspace) |
| **Integration**    | eslint-config-prettier ^10.1.8      |

## Configuration

Root `package.json`:

```json
"prettier": "@athlya/prettier-config"
```

The shared config package (`packages/prettier-config`) centralizes formatting rules for the monorepo. All packages inherit this config.

## Patterns Applied

1. **Shared config**: Single source of truth via workspace package
2. **ESLint integration**: `eslint-config-prettier` placed last in ESLint config array (disables conflicting rules)
3. **Format command**: `prettier --write "**/*.{ts,tsx,js,jsx,json,md,yaml,yml}"`
4. **Check command**: `prettier --check` (CI verification)

## No Issues Detected

Prettier 3.x is current and stable. The integration with ESLint via `eslint-config-prettier` is correctly placed last in the flat config array.

## Checklist

- [x] Shared config via workspace package
- [x] ESLint conflict resolution (config-prettier last)
- [x] Format + check scripts at root
- [x] Covers all relevant file types

## Source

- https://prettier.io/docs/en/
