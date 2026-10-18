// @ts-check
import { config as react } from '@athlya/eslint-config/react';

/**
 * Flat ESLint config for `@athlya/mobile`: the shared React preset with
 * type-aware rules. Expo/Metro/Babel/Tailwind config files are CommonJS
 * or loaded by their own tools and stay outside the TypeScript project.
 *
 * @type {import('eslint').Linter.Config[]}
 */
export default [
  {
    ignores: [
      '.expo/**',
      'android/**',
      'ios/**',
      'dist/**',
      'babel.config.js',
      'metro.config.js',
      'tailwind.config.ts',
      'eslint.config.mjs',
    ],
  },
  ...react,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
