/**
 * Vitest config for the Athlya web app.
 *
 * Task 10.6 introduced React component tests (`LocaleSwitcher`) and
 * client-side cookie assertions, so the environment is now `jsdom`
 * and the automatic JSX runtime is wired at the Oxc transform level —
 * `tsconfig.json` uses `"jsx": "preserve"` for Next.js, but Vitest
 * compiles test files directly through Oxc (Vite 8) and needs its own
 * instruction to emit `jsx-runtime` imports instead of bare
 * `React.createElement` calls.
 *
 * The pure-module tests from task 10.1 (CSP, nonce) run fine under
 * jsdom too — `btoa`, `crypto.getRandomValues` etc. are all present.
 *
 * Vite 8 resolves tsconfig `paths` natively (`resolve.tsconfigPaths`),
 * so the `@/` alias stays in sync with the TypeScript project without
 * being re-declared here.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
