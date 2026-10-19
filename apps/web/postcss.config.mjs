/**
 * PostCSS config for Tailwind 4 in the Athlya web app.
 *
 * Tailwind 4 is CSS-first: the entry point is `@import "tailwindcss"` in
 * `src/app/globals.css`, not a JS/TS preset. This file exists purely to
 * register the `@tailwindcss/postcss` plugin so Next.js' PostCSS pipeline
 * picks it up.
 *
 * Note: task 10.1 originally referenced a shared `packages/config/tailwind`
 * preset. Tailwind 4 replaced the JS preset model with the `@theme` CSS
 * at-rule, so the shared preset is no longer necessary — the equivalent
 * design tokens are pulled from `@athlya/shared/tokens` into CSS custom
 * properties in the shared `@athlya/shared/theme.css`.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
