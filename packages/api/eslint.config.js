// @ts-check
import athlya from '@athlya/eslint-config';

/**
 * ESLint flat config for `@athlya/api`.
 *
 * The base config's `parserOptions.projectService = true` auto-discovers
 * this package's `tsconfig.json`, which now includes both `src/` and
 * `tests/`, so every lintable file is covered without additional
 * per-file overrides. Build output is ignored explicitly.
 */
export default [
    {
        ignores: ['dist/**', '.turbo/**', 'coverage/**', '*.tsbuildinfo', '.wrangler/**'],
    },
    ...athlya,
    {
        // Relax strict rules that produce false positives in test files:
        //   - unbound-method: vi.fn() stubs are not class methods, this binding is irrelevant
        //   - require-await: async stubs intentionally match async interface signatures
        //   - no-unsafe-*: mock.calls / JSON response access is inherently untyped
        files: ['src/**/*.test.ts', 'src/__tests__/**/*.ts'],
        rules: {
            '@typescript-eslint/unbound-method': 'off',
            '@typescript-eslint/require-await': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-return': 'off',
            '@typescript-eslint/consistent-type-imports': 'off',
            '@typescript-eslint/await-thenable': 'off',
            '@typescript-eslint/prefer-promise-reject-errors': 'off',
            '@typescript-eslint/no-base-to-string': 'off',
        },
    },
];
