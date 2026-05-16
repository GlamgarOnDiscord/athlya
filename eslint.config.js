// @ts-check
/**
 * Root ESLint flat config for the Athlya monorepo.
 *
 * Each package or app may define its own `eslint.config.js` that extends
 * `@athlya/eslint-config` (base) or `@athlya/eslint-config/react` as needed.
 * This root config is intentionally minimal — it exists so the repo can be
 * linted from the root and so tooling (IDEs, CI) discovers a config.
 */
import athlya from '@athlya/eslint-config';

export default [
    {
        ignores: [
            '**/node_modules/**',
            '**/dist/**',
            '**/build/**',
            '**/.next/**',
            '**/.turbo/**',
            '**/coverage/**',
            '**/*.tsbuildinfo',
            // Config-only packages: nothing to lint yet.
            'packages/tsconfig/**',
            'packages/prettier-config/**',
            'packages/eslint-config/**',
        ],
    },
    ...athlya,
];
