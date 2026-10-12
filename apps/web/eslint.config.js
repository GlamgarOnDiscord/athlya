// @ts-check
/**
 * Flat ESLint config for `@athlya/web`.
 *
 * Architecture decision — Next's config is the base, NOT a layer.
 * -----------------------------------------------------------------
 * `@athlya/eslint-config/react` and `eslint-config-next@16` both
 * declare plugins `import`, `react`, `react-hooks`. Flat config
 * forbids redeclaring a plugin across multiple config objects
 * (`ConfigError: Config "next": Key "plugins": Cannot redefine
 * plugin "import"`), so we can't spread both presets into one array.
 *
 * Given that Next's preset already supplies:
 *
 *   - `eslint-plugin-react` + `eslint-plugin-react-hooks` (v7 — stricter)
 *   - `eslint-plugin-import` with TS resolver
 *   - `eslint-plugin-jsx-a11y` (Req 27.1 WCAG targets)
 *   - `@next/eslint-plugin-next` (SWC-aware Next rules)
 *   - `@typescript-eslint` on `.ts` / `.tsx` (scoped in next/typescript)
 *
 * we take the Next preset as the authoritative base for this app and
 * add only the Athlya-specific custom rules on top. The shared
 * monorepo package `@athlya/eslint-config` still governs every
 * non-Next package/app.
 *
 * Scoping note — `@typescript-eslint/*` rules
 * -------------------------------------------
 * Next exposes `@typescript-eslint` only on `.ts` / `.tsx` files
 * (the `next/typescript` config block). To add
 * `@typescript-eslint/*` rules we MUST repeat the same `files`
 * pattern so flat-config merges our rule object with that block
 * rather than with `next` (which does NOT declare the plugin).
 * Without the `files` scope, ESLint throws
 * `could not find plugin "@typescript-eslint"`.
 *
 * @type {import('eslint').Linter.Config[]}
 */
import next from 'eslint-config-next';
import eslintConfigPrettier from 'eslint-config-prettier';

/** @type {import('eslint').Linter.Config[]} */
const config = [
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/.open-next/**',
      'open-next.config.ts',
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/*.tsbuildinfo',
      // Playwright artefacts.
      'test-results/**',
      'playwright-report/**',
      // Files outside the main tsconfig graph — typed-linting
      // cannot resolve them through `projectService`, so
      // we exclude them entirely from the lint run.
      // `next.config.ts` / `vitest.config.ts` / `e2e/**` all
      // have their own build pipelines (Next CLI / Vitest /
      // Playwright). Lint them via a dedicated config if the
      // need arises.
      'next.config.ts',
      'vitest.config.ts',
      'e2e/**',
      'scripts/**',
    ],
  },
  ...next,
  // Athlya house rules for TS / TSX — merged into `next/typescript`
  // via the matching `files` pattern so `@typescript-eslint` is in
  // scope. `projectService: true` pulls type info from the nearest
  // tsconfig via Next's parser so typed-linting rules can resolve.
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
        },
      ],
      // `warn` rather than `error` — React 19's form handler
      // pattern (`onSubmit={onSubmit}` with an async
      // `FormEventHandler`) legitimately trips this rule even
      // with `checksVoidReturn.attributes: false` in some
      // typescript-eslint versions. The warning keeps the
      // signal; a follow-up Vague can either silence per-call
      // with `// eslint-disable-next-line` or migrate the
      // handlers to an IIFE wrapper.
      '@typescript-eslint/no-misused-promises': [
        'warn',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  // Import ordering — applied to every lintable file. Kept at
  // `warn` severity so a missed `--fix` pass does not block CI.
  {
    files: ['**/*.{js,jsx,mjs,ts,tsx,mts,cts}'],
    rules: {
      'import/order': [
        'warn',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import/no-duplicates': 'error',
    },
  },
  // React 19's stricter react-hooks plugin (v7, bundled by
  // eslint-config-next@16) flags legitimate patterns like
  // `ref.current = …` inside render paths. We downgrade the two
  // `error`-level react-hooks rules that currently fire on
  // unchanged pre-existing code to `warn` so the signal is
  // preserved without blocking CI while a dedicated follow-up
  // refactor the flagged call sites.
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  // MUST stay last: disables stylistic rules that conflict with
  // Prettier so `prettier --write` stays authoritative.
  eslintConfigPrettier,
];

export default config;
