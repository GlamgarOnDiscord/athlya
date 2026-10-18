import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  workspaces: {
    '.': {
      entry: [],
      project: [],
    },
    'apps/web': {
      entry: [
        'src/app/**/{page,layout,loading,error,not-found}.tsx',
        'src/app/**/route.ts',
        'src/proxy.ts',
        'src/middleware.ts',
        // shadcn/ui — all subcomponent exports treated as public API
        'src/components/ui/*.tsx',
        // Test helpers with intentional public exports
        'src/lib/auth/token-store.ts',
      ],
      project: ['src/**/*.{ts,tsx}'],
      ignore: ['src/**/*.test.{ts,tsx}', 'scripts/**'],
    },
    'apps/studio': {
      entry: [
        'src/app/**/{page,layout,loading,error,not-found}.tsx',
        'src/app/**/route.ts',
        'src/proxy.ts',
        'src/middleware.ts',
        // shadcn/ui — all subcomponent exports treated as public API
        'src/components/ui/*.tsx',
        // Test helpers with intentional public exports
        'src/lib/auth/token-store.ts',
      ],
      project: ['src/**/*.{ts,tsx}'],
      ignore: ['src/**/*.test.{ts,tsx}'],
    },
    'apps/mobile': {
      entry: ['app/**/*.tsx', 'tests/**/*.test.ts'],
      project: ['{app,components,infrastructure,theme,tests}/**/*.{ts,tsx}'],
    },
    'packages/api': {
      entry: ['src/worker.ts', 'src/index.ts'],
      project: ['src/**/*.ts'],
      ignore: ['src/__tests__/**'],
    },
    'packages/auth': {
      entry: ['src/index.ts'],
      project: ['src/**/*.ts'],
      ignore: ['src/__tests__/**'],
    },
    'packages/db': {
      entry: ['src/index.ts', 'src/client.ts', 'src/schema/index.ts'],
      project: ['src/**/*.ts'],
      ignore: ['src/__tests__/**', 'scripts/**'],
    },
    'packages/shared': {
      entry: [
        'src/index.ts',
        'src/i18n/index.ts',
        'src/schemas/api.ts',
        'src/codec/index.ts',
        'src/events.ts',
      ],
      project: ['src/**/*.ts'],
      ignore: ['src/**/*.test.ts'],
    },
    'packages/members': {
      entry: ['src/index.ts'],
      project: ['src/**/*.ts'],
      ignore: ['src/__tests__/**'],
    },
    'packages/billing': {
      entry: ['src/index.ts'],
      project: ['src/**/*.ts'],
      ignore: ['src/__tests__/**'],
    },
    'packages/notifications': {
      entry: ['src/index.ts'],
      project: ['src/**/*.ts'],
      ignore: ['src/__tests__/**'],
    },
    'packages/ratelimit': {
      entry: ['src/index.ts'],
      project: ['src/**/*.ts'],
      ignore: ['src/__tests__/**'],
    },
    'packages/reservations': {
      entry: ['src/index.ts'],
      project: ['src/**/*.ts'],
      ignore: ['src/__tests__/**'],
    },
  },
  ignore: [
    '**/dist/**',
    '**/.next/**',
    '**/.turbo/**',
    '**/node_modules/**',
    '**/coverage/**',
    '**/.wrangler/**',
  ],
  ignoreDependencies: [
    // CSS-only or CLI tools — Knip can't trace non-JS imports
    'tw-animate-css',
    'tailwindcss',
    'shadcn',
    'react-day-picker',
    // Config-file-only — not imported in source
    '@athlya/eslint-config',
    '@athlya/tsconfig',
    'eslint-config-prettier',
    'server-only',
    // Declared in advance for future features — not yet imported in source
    '@athlya/shared',
    '@athlya/db',
    'zod',
    // Mobile: NativeWind's Babel preset loads this plugin by name, which pnpm's
    // isolated layout only resolves from the app; knip's Expo plugin assumes
    // expo-updates for every app.json although OTA updates are not used.
    '@babel/plugin-transform-react-jsx',
    'expo-updates',
    // Testing infrastructure consumed by runners, not source imports
    '@testing-library/react',
    '@testing-library/jest-dom',
    '@fast-check/vitest',
    'fast-check',
    'testcontainers',
    '@vitest/coverage-v8',
  ],
  ignoreExportsUsedInFile: true,
  ignoreFiles: [
    // Intentional future code — RGPD maintenance runner not yet wired in worker.ts
    'packages/api/src/maintenance/audit-anonymize.ts',
    'packages/api/src/maintenance/scheduled-runner.ts',
    // Reserved shadcn components for future use
    'apps/studio/src/components/ui/calendar.tsx',
    'apps/studio/src/components/ui/popover.tsx',
    'apps/studio/src/components/ui/separator.tsx',
    'apps/studio/src/components/ui/sheet.tsx',
    // shadcn/ui re-exports all subcomponents by convention — only some are consumed today
    'apps/studio/src/components/ui/card.tsx',
    'apps/studio/src/components/ui/dialog.tsx',
    'apps/studio/src/components/ui/table.tsx',
    'apps/web/src/components/ui/card.tsx',
    'apps/web/src/components/ui/dialog.tsx',
    // Test reset helper — intentionally exported for test teardown
    'apps/studio/src/lib/auth/token-store.ts',
  ],
};

export default config;
