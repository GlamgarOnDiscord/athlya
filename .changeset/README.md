# Changesets

This directory is managed by [Changesets](https://github.com/changesets/changesets).

## Workflow

1. When opening a PR that changes package behaviour, run `pnpm changeset` at the monorepo root to create a changeset file describing the change (patch / minor / major + summary).
2. Commit the generated `.changeset/<random-name>.md` alongside your code changes.
3. On merge to `master`, the [Release workflow](../.github/workflows/release.yml) automatically opens (or updates) a **"Version Packages"** pull request that bumps all affected package versions and updates their `CHANGELOG.md` files.
4. When the team is ready to cut a release, merge the Version Packages PR. That commit becomes the release point; tag it manually or let CI create the tag.

## Commands

```bash
# Describe the change you made (interactive prompt)
pnpm changeset

# Preview which packages will be bumped and by how much
pnpm changeset:status

# Apply pending changesets — bump package.json versions + update CHANGELOGs
# (normally run by CI, not by hand)
pnpm changeset:version
```
