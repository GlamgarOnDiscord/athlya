# PostCSS — Framework Audit

## Version Status

|             | Value                             |
| ----------- | --------------------------------- |
| **Used**    | ^8.4.49                           |
| **Plugin**  | @tailwindcss/postcss ^4.3.0       |
| **Purpose** | CSS processing for Tailwind CSS 4 |

## Configuration

`apps/web/postcss.config.mjs` — minimal config loading `@tailwindcss/postcss`.

In Tailwind 4, the PostCSS plugin replaces the old `tailwindcss` plugin. No additional plugins needed:

- No `autoprefixer` (Tailwind 4 handles this internally via Lightning CSS)
- No `postcss-import` (Tailwind 4 handles `@import` internally)

## Assessment

PostCSS 8.x is the current major version. The project's usage is minimal — it's only a host for the Tailwind 4 plugin. No custom PostCSS plugins or transforms.

## Note

For non-Next.js projects using Vite, `@tailwindcss/vite` is preferred over PostCSS. Since Next.js uses PostCSS for CSS processing, the current setup is correct.

## Checklist

- [x] PostCSS 8.x (current)
- [x] @tailwindcss/postcss (Tailwind 4 plugin)
- [x] No redundant plugins (autoprefixer, postcss-import)

## Source

- https://postcss.org/
- https://tailwindcss.com/docs/installation/using-postcss
