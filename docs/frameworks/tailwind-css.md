# Tailwind CSS 4 — Framework Audit

_Last updated: 2026-05-14_

## Version Status

|                     | Value                             |
| ------------------- | --------------------------------- |
| **Used**            | ^4.3.0                            |
| **Latest**          | 4.3.x (current)                   |
| **Plugin**          | @tailwindcss/postcss ^4.3.0       |
| **Config approach** | CSS-first (no tailwind.config.js) |

---

## Tailwind 4.3 — What's New

### `bg-linear-*` Replaces `bg-gradient-*`

```css
/* OBSOLETE — bg-gradient-to-r */
bg-gradient-to-r from-blue-500 to-indigo-500

/* CURRENT — bg-linear */
bg-linear-to-r from-blue-500 to-indigo-500
```

The `bg-gradient-*` utilities still work (aliased for backwards compatibility) but `bg-linear-*` is now the canonical name. Use `bg-linear-*` for all new gradients.

### `min-h-screen` → `min-h-svh` / `min-h-dvh`

```tsx
/* OBSOLETE — doesn't account for mobile browser chrome */
className = 'min-h-screen';

/* CURRENT — dynamic viewport height (shrinks/grows with browser UI) */
className = 'min-h-dvh';

/* STABLE — small viewport (always excludes browser UI) */
className = 'min-h-svh';
```

The `min-h-screen` utility maps to `100vh` which is broken on mobile browsers. `min-h-dvh` maps to `100dvh` and is the correct replacement. The project already uses `min-h-[100dvh]` (arbitrary value) — use the utility `min-h-dvh` instead.

### `field-sizing-content` — Auto-sizing Textareas

```tsx
<textarea className="field-sizing-content" />
```

Textarea grows to fit its content without JavaScript. Replaces most `autosize` library use cases.

### `not-*` Variant

```tsx
/* Style elements that do NOT match a condition */
className = 'not-hover:opacity-50';
className = 'not-last:border-b';
```

### `inset-shadow-*` Utilities

```tsx
className = 'inset-shadow-sm inset-shadow-black/10';
```

First-class inset box shadows (previously only possible with `box-shadow` arbitrary values).

---

## Tailwind 4 — Configuration Patterns (Already Correct)

### CSS-First Configuration

The project correctly uses the new CSS-first approach:

```css
@import 'tailwindcss';
@theme {
  --color-background: var(--color-background);
}
```

### Token Architecture (Correct)

```
@athlya/shared/tokens.ts (source of truth)
    → tokens.css (CSS custom properties)
        → globals.css @theme (Tailwind utilities)
```

### Dark Mode (Correct)

Using `@media (prefers-color-scheme: dark)` to swap CSS variable values. Tailwind 4's `dark:` variant uses this automatically.

---

## Patterns to Update

### 1. Replace `[color:var(...)]` Arbitrary Syntax

```tsx
/* VERBOSE — current */
className = 'text-[color:var(--color-muted-foreground)]';
className = 'bg-[color:var(--athlya-brand-primary)]';

/* CLEAN — if registered in @theme */
className = 'text-muted-foreground';
className = 'bg-brand-primary';
```

Verify that `@theme` registration makes these utilities available. If `--color-muted-foreground` is registered in `@theme`, Tailwind 4 generates `text-muted-foreground` automatically.

### 2. Replace `min-h-[100dvh]` with `min-h-dvh`

```tsx
/* Current (arbitrary value) */
className = 'min-h-[100dvh]';

/* Preferred (utility) */
className = 'min-h-dvh';
```

The utility is cleaner and handles responsive variants better.

### 3. Check Renamed Utilities from Tailwind 3

| Tailwind 3                 | Tailwind 4                              | Status                  |
| -------------------------- | --------------------------------------- | ----------------------- |
| `shadow-sm`                | `shadow-xs`                             | Verify usage            |
| `blur-sm`                  | `blur-xs`                               | Verify usage            |
| `rounded-sm`               | `rounded-xs`                            | Verify usage            |
| `bg-gradient-to-*`         | `bg-linear-to-*`                        | Prefer new name         |
| `!flex` (important prefix) | `flex!` (important suffix)              | Verify usage            |
| `bg-opacity-*`             | slash syntax `bg-black/50`              | Verify usage            |
| `ring` default             | `currentColor/1px` (was `blue-500/3px`) | Verify form focus rings |

Run the upgrade tool to detect remaining v3 patterns:

```bash
pnpm dlx @tailwindcss/upgrade --cwd apps/web
pnpm dlx @tailwindcss/upgrade --cwd apps/studio
```

---

## Breaking Changes from Tailwind 3 (for reference)

| Tailwind 3                            | Tailwind 4                            | Status in Project       |
| ------------------------------------- | ------------------------------------- | ----------------------- |
| `@tailwind base/components/utilities` | `@import 'tailwindcss'`               | Migrated                |
| `tailwind.config.js`                  | `@theme` in CSS                       | Migrated                |
| `theme.extend` in JS                  | `@theme` block in CSS                 | Using CSS-first         |
| `darkMode: 'class'` config            | `@media (prefers-color-scheme: dark)` | Using media query       |
| CSS preprocessors (Sass/Less)         | Native CSS nesting                    | Not used                |
| Variant stacking right-to-left        | Left-to-right (CSS-like)              | Verify stacked variants |

---

## New Directives Available

| Directive                      | Purpose                               | Potential Use               |
| ------------------------------ | ------------------------------------- | --------------------------- |
| `@utility`                     | Custom utilities with variant support | Custom component styles     |
| `@variant` / `@custom-variant` | Apply/create variants                 | Theme-specific variants     |
| `@source`                      | Explicit content scanning             | Workspace package classes   |
| `not-*` variant                | Style non-matching elements           | Dividers, conditional hover |

### `@source` for Workspace Packages

If Tailwind misses class usage from `@athlya/shared` or other workspace packages:

```css
/* apps/web/src/app/globals.css */
@source "../../../packages/shared/src";
```

---

## Performance

- Oxide engine (Rust-based) — significantly faster builds than v3
- Auto content detection — no `content` array needed
- `@tailwindcss/postcss` is correct for Next.js (which uses PostCSS)

---

## Checklist

- [x] CSS-first configuration (`@import 'tailwindcss'` + `@theme`)
- [x] Using `@tailwindcss/postcss` plugin
- [x] Design tokens as CSS custom properties
- [x] Dark mode via `prefers-color-scheme`
- [x] No `tailwind.config.js`
- [ ] Replace `min-h-[100dvh]` with `min-h-dvh` utility
- [ ] Replace `bg-gradient-*` with `bg-linear-*` in new code
- [ ] Replace verbose `[color:var(...)]` with direct utility names
- [ ] Verify `shadow-sm`/`blur-sm`/`rounded-sm` usages (renamed in v4)
- [ ] Run `npx @tailwindcss/upgrade` to audit remaining v3 patterns
- [ ] Consider `@source` directive for workspace package scanning

## Sources

- https://tailwindcss.com/docs/upgrade-guide
- https://tailwindcss.com/docs/installation
- https://tailwindcss.com/docs/functions-and-directives
- https://tailwindcss.com/blog/tailwindcss-v4-3
