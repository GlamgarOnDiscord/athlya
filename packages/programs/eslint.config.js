// @ts-check
import athlya from '@athlya/eslint-config';

/**
 * ESLint flat config for `@athlya/programs`.
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
    files: ['src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
];
