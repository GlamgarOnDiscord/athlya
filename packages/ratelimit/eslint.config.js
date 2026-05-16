// @ts-check
import athlya from '@athlya/eslint-config';

/**
 * ESLint flat config for `@athlya/ratelimit`.
 *
 * The base config's `parserOptions.projectService = true` auto-discovers
 * this package's `tsconfig.json`, which includes both `src/` and
 * `tests/`, so every lintable file is covered without additional
 * per-file overrides. Build output is ignored explicitly.
 */
export default [
    {
        ignores: ['dist/**', '.turbo/**', 'coverage/**', '*.tsbuildinfo'],
    },
    ...athlya,
];
