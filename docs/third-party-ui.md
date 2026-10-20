# Third-party UI code

_Ledger of UI source code copied into the repo (components, hooks, animation snippets, illustrations). Last updated: 2026-10-19._

npm dependencies are not listed here: they come with their own licence files and are covered by the lockfile. This page is for code or assets **copied into** the tree, where the licence notice would otherwise get lost.

## Rules

1. Only from the sources allowed in [`docs/design/ui-direction.md`](design/ui-direction.md#allowed-component-sources), and only when the licence is confirmed for that exact component (21st.dev and Aceternity UI are per component).
2. Preserve the upstream copyright and permission notices in the copied file: for MIT and ISC they are a condition of the licence. Also add a header comment naming the source, the licence and the upstream URL, as repository metadata.
3. Replace hard-coded colours, radii and spacing with the shared tokens before merging. A shadcn/ui CLI run may write colour variables into `globals.css`; remove them, the theme comes from `@athlya/shared/theme.css`.
4. Add a row below in the same PR.

## Entries

| Component | Source URL | Licence | What was changed |
| --------- | ---------- | ------- | ---------------- |

The shared theme PR (#706) copies nothing.

### Present before this ledger

The shadcn/ui components under `apps/web/src/components/ui/` (button, card, checkbox, dialog, input, label, separator, skeleton, sonner) and `apps/studio/src/components/ui/` (badge, button, card, dialog, input, label, skeleton, sonner, table) were added with the shadcn CLI (style `base-nova`) before this ledger existed. Source: [ui.shadcn.com](https://ui.shadcn.com), licence MIT ([upstream licence](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md)). They read colours through the shadcn/ui bridge in the shared theme; per-file changes against upstream have not been audited yet and get a row each when a screen PR touches them.
