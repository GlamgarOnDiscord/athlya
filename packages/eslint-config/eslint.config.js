// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';

/**
 * Shared base ESLint flat config for the Athlya monorepo.
 *
 * Consumers extend this array from their local `eslint.config.js`, e.g.:
 *
 *   import athlya from '@athlya/eslint-config';
 *   export default [...athlya, { files: ['src/**\/*.ts'], rules: { ... } }];
 *
 * Downstream packages that opt into `typescript-eslint`'s type-checked rules
 * MUST set `parserOptions.projectService = true` (or provide `project`) in their
 * own config to pin the tsconfig used for type information.
 *
 * @type {import('eslint').Linter.Config[]}
 */
export const config = [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
      parserOptions: {
        projectService: true,
      },
    },
    plugins: {
      import: importPlugin,
      'unused-imports': unusedImports,
    },
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
        },
        node: true,
      },
    },
    rules: {
      // typescript-eslint tuning
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': 'off', // handled by unused-imports
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],

      // unused-imports
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
        },
      ],

      // eslint-plugin-import — structural rules that don't need type info
      'import/no-duplicates': 'error',
      'import/order': [
        'warn',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
    },
  },
  {
    // Config files are typically plain JS without a project — relax type-aware rules.
    files: ['**/*.{js,cjs,mjs}', '**/*.config.{ts,js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  // MUST stay last: disables stylistic rules that conflict with Prettier.
  eslintConfigPrettier,
];

export default config;
