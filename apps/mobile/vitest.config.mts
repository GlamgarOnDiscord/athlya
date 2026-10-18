/**
 * The infrastructure layer (token store, API client, mutation queue,
 * drain, sync controller) is plain TypeScript with the native modules
 * behind interfaces, so the suite runs in Node without a device.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 30_000,
  },
});
