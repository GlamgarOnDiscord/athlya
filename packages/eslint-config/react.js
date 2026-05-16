// @ts-check
import pluginReact from 'eslint-plugin-react';
import pluginReactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

import base from './eslint.config.js';

/**
 * Shared ESLint flat config for React / React Native targets in the Athlya
 * monorepo. Composes the base config from `@athlya/eslint-config` and adds
 * React + React Hooks rules with the new JSX transform.
 *
 * @type {import('eslint').Linter.Config[]}
 */
export const config = [
  ...base,
  {
    files: ['**/*.{jsx,tsx}'],
    ...pluginReact.configs.flat.recommended,
    languageOptions: {
      ...pluginReact.configs.flat.recommended.languageOptions,
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
      },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...pluginReact.configs.flat.recommended.rules,
      // New JSX transform — React doesn't need to be in scope.
      'react/react-in-jsx-scope': 'off',
      'react/jsx-uses-react': 'off',
    },
  },
  {
    files: ['**/*.{jsx,tsx}'],
    plugins: {
      'react-hooks': pluginReactHooks,
    },
    rules: {
      ...pluginReactHooks.configs.recommended.rules,
    },
  },
];
