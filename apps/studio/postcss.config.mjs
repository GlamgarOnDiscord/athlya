/**
 * PostCSS config for Tailwind 4 in the Athlya studio admin app. Same
 * as `apps/web/postcss.config.mjs` — the engine is registered through
 * `@tailwindcss/postcss` and the actual config lives in `globals.css`
 * via `@import "tailwindcss"` + `@theme` declarations.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
