/**
 * Vitest configuration for `@athlya/programs`: pure domain logic, no
 * database, no DOM.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    globals: false,
    environment: 'node',
  },
});
