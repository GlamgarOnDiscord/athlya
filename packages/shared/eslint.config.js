// @ts-check
import athlya from '@athlya/eslint-config';

/**
 * ESLint flat config for `@athlya/shared`.
 *
 * The base config enables `parserOptions.projectService` on typescript-eslint,
 * which auto-discovers this package's `tsconfig.json` for files under `src/`.
 * Test-tree files (`tests/**`) live outside the build project on purpose —
 * they are covered by `tsconfig.tests.json`. The override below tells
 * typescript-eslint to discover them via the test-specific project so
 * type-aware rules keep working without forcing tests into the shipping
 * build.
 */
export default [
    {
        ignores: ['dist/**', '.turbo/**', 'coverage/**', '*.tsbuildinfo', 'scripts/**'],
    },
    ...athlya,
    {
        files: ['tests/**/*.ts', 'src/**/*.test.ts', 'vitest.config.ts'],
        languageOptions: {
            parserOptions: {
                // The base config enables `projectService: true` for
                // typescript-eslint. That auto-discovery only looks at
                // the nearest `tsconfig.json`, which here covers only
                // non-test files under `src/` — test files (both the
                // `tests/` tree and co-located `src/**/*.test.ts`) live
                // outside that project on purpose. Switch to the
                // classic `project` mode for test-tree files and point
                // it at the test-specific tsconfig so type-aware rules
                // keep working.
                projectService: false,
                project: ['./tsconfig.tests.json'],
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
];
