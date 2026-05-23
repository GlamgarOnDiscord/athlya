// @ts-check
/**
 * Flat ESLint config for `@athlya/studio`. Mirrors `apps/web/eslint.config.js`
 * — see the architecture note there for why Next's preset is the
 * authoritative base instead of being layered with
 * `@athlya/eslint-config/react`.
 *
 * @type {import('eslint').Linter.Config[]}
 */
import next from 'eslint-config-next';
import eslintConfigPrettier from 'eslint-config-prettier';

/** @type {import('eslint').Linter.Config[]} */
const config = [
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/*.tsbuildinfo',
      'test-results/**',
      'playwright-report/**',
      'next.config.ts',
      'vitest.config.ts',
      'e2e/**',
      'scripts/**',
    ],
  },
  ...next,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
        },
      ],
      '@typescript-eslint/no-misused-promises': [
        'warn',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  {
    files: ['**/*.{js,jsx,mjs,ts,tsx,mts,cts}'],
    rules: {
      'import/order': [
        'warn',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import/no-duplicates': 'error',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  eslintConfigPrettier,
];

export default config;
