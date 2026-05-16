/**
 * Vitest config for the Athlya web app.
 *
 * Task 10.6 introduced React component tests (`LocaleSwitcher`) and
 * client-side cookie assertions, so the environment is now `jsdom`
 * and the automatic JSX runtime is wired at the esbuild level —
 * `tsconfig.json` uses `"jsx": "preserve"` for Next.js, but Vitest
 * compiles test files directly through esbuild and needs its own
 * instruction to emit `jsx-runtime` imports instead of bare
 * `React.createElement` calls.
 *
 * The pure-module tests from task 10.1 (CSP, nonce) run fine under
 * jsdom too — `btoa`, `crypto.getRandomValues` etc. are all present.
 *
 * Vite 7 no longer reads tsconfig `paths` automatically, so we
 * re-declare the `@/` alias here to keep Vitest resolution in sync
 * with the TypeScript project.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
