# eslint-config-next / next.config.ts — Framework Audit

*Last updated: 2026-05-14*

## Version Status

| | Value |
|---|---|
| **eslint-config-next** | ^16.2.6 (devDep in apps/web) |
| **next-config** | `next.config.ts` (TypeScript config — correct) |

---

## `next lint` Removed in Next.js 16

The `next lint` command has been removed from Next.js 16. The project's `lint` script in `apps/web/package.json` must be updated:

```json
// BEFORE (Next.js 14/15)
{ "lint": "next lint" }

// AFTER (Next.js 16)
{ "lint": "eslint src --ext .ts,.tsx" }
```

**Also**: `eslint-config-next` ^16 exports a flat config. This allows deleting `apps/web/.eslintrc.json` (legacy format) and creating `apps/web/eslint.config.js`:

```js
// apps/web/eslint.config.js
import { config as athlyaConfig } from '@athlya/eslint-config/react';
import nextPlugin from '@next/eslint-plugin-next';

export default [
    ...athlyaConfig,
    {
        plugins: { '@next/next': nextPlugin },
        rules: {
            ...nextPlugin.configs.recommended.rules,
            ...nextPlugin.configs['core-web-vitals'].rules,
        },
    },
];
```

See `eslint.md` for the full migration plan.

---

## next.config.ts — Current Patterns

### `cacheComponents` (PPR) — Not Yet Enabled

```ts
// next.config.ts
export default {
    cacheComponents: true, // enables Partial Prerendering
};
```

Not enabled yet. Enabling `cacheComponents` activates PPR which requires adding `'use cache'` directives to pages. See `nextjs.md` for the usage pattern.

### `transpilePackages`

```ts
transpilePackages: ['@athlya/shared']
```

Required for workspace packages that export TypeScript source. Correct.

### `images.domains` → `images.remotePatterns`

`images.domains` is deprecated in Next.js 16. Replace with:

```ts
// BEFORE (deprecated)
images: { domains: ['cdn.athlya.app'] }

// AFTER (current)
images: {
    remotePatterns: [
        {
            protocol: 'https',
            hostname: 'cdn.athlya.app',
            pathname: '/**',
        }
    ]
}
```

---

## Checklist

- [x] `next.config.ts` (TypeScript config — correct)
- [x] `transpilePackages` for workspace packages
- [ ] **Update `lint` script: `next lint` → `eslint src --ext .ts,.tsx`**
- [ ] Migrate `apps/web/.eslintrc.json` → `apps/web/eslint.config.js` (see eslint.md)
- [ ] Enable `cacheComponents: true` for PPR on public pages
- [ ] Migrate `images.domains` → `images.remotePatterns` if domains are configured

## Sources

- https://nextjs.org/docs/app/api-reference/config/eslint
- https://nextjs.org/docs/app/api-reference/config/next-config-js
- https://nextjs.org/docs/app/getting-started/caching
