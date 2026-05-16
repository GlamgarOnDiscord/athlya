// @ts-check
import athlya from '@athlya/eslint-config';

/**
 * ESLint flat config for `@athlya/auth`.
 *
 * The base config's `parserOptions.projectService = true` auto-discovers
 * this package's `tsconfig.json`, so no extra wiring is needed beyond
 * ignoring build output.
 */
export default [
  {
    ignores: ['dist/**', '.turbo/**', 'coverage/**', '*.tsbuildinfo'],
  },
  ...athlya,
  {
    files: ['src/**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
];
