/**
 * Vitest configuration for `@athlya/ai-coach`.
 *
 * Unit tests and fast-check properties live under `tests/`. Every test
 * drives the service with the AI SDK mock model, so nothing reaches the
 * network.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    globals: false,
    environment: 'node',
    pool: 'threads',
    testTimeout: 30_000,
  },
});
