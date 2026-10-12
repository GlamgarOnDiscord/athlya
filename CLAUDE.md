# CLAUDE.md — Athlya

Guidance for AI agents working in this repo. Keep changes small, tested, and reviewed.

## Workflow — follow the `/ship` skill

Any code/config/docs change goes through the **`/ship`** workflow
(`.claude/skills/ship/SKILL.md`):

1. **Issue** (detailed) for any feature/fix/security/non-trivial change.
   Skip only for trivial chores (formatting, lockfile sync, typo).
2. **Branch** `fix/issue-XX-…` | `feat/…` | `chore/…` off up-to-date `master`.
3. **EPCT** — explore → plan → code → test. Add tests for new logic.
4. ⭐ **`pnpm preflight`** before pushing (the `.githooks/pre-push` hook runs it).
   = `install --frozen-lockfile && format:check && lint && typecheck`.
5. **PR** with `Closes #XX`.
6. ⭐ **AI bot reviews are mandatory**: read ALL CodeRabbit/cubic/Copilot
   feedback — inline (`gh api .../pulls/<n>/comments`), PR conversation
   (`gh api .../issues/<n>/comments`, where CodeRabbit posts its summary) AND
   review bodies (`gh pr view <n> --json reviews`) — and apply the good ones
   BEFORE merge and BEFORE close. Re-check right before merging — reviews land late.
7. **Merge** only when **ALL** checks are green:
   `gh pr merge <n> --squash --delete-branch` (add `--admin` only to bypass a
   _proven_ flake, never as the default).

Watch CI with the **`Monitor`** tool, never `sleep`. Rerun known flakes
(Docker registry timeout, `round-trip` property seed) with `gh run rerun <id> --failed`.

## Hard rules

- Code, comments, identifiers, commits: **English only**. No scaffolding comments.
- Commits: conventional, **no Claude attribution**; use the repo's configured
  git identity (`git config user.name` / `user.email`).
- Node 24 LTS (`.nvmrc`, `engines`). pnpm 11 (`packageManager`; settings and
  overrides live in `pnpm-workspace.yaml`, not `package.json`/`.npmrc`).
  Keep `@types/node` on the `.nvmrc` major.
- pnpm 11 enforces a 24h `minimumReleaseAge`: don't add
  `minimumReleaseAgeExclude` entries — pick the previous release instead.
- Security overrides use the scoped form `pkg@<fixed>: ^fixed`, never an
  open-ended `>=` (it silently jumps consumers to new majors).
- `format:check` is repo-wide — keep every tracked file prettier-clean.
- In `packages/api` tests, read responses with the `readJson<T>(res)` helper,
  not an inline `(await res.json()) as T` (typescript-eslint vs tsc disagree).
- Only `Lint, typecheck, and tests` is a required check; pgTAP runs on
  `packages/db/migrations/**`, axe/E2E on `apps/**`.

## Database migrations — expand/contract required for canary safety

The deploy pipeline uses a canary strategy (CN.7.1). The old Worker version
runs alongside the new one during rollout. Any migration that breaks the old
code during that window causes 1-100% request failures.

**Required pattern for schema changes:**

1. **Expand** — add the new column/index as `nullable` with no breaking
   constraint. Deploy. Both old and new Workers coexist safely.
2. **Deploy code** — new Worker starts writing the new column/field.
3. **Contract** _(separate migration, separate deploy)_ — add `NOT NULL`,
   drop old columns, rename. Old Workers are gone by this point.

**Never** do `ADD COLUMN col NOT NULL` without a `DEFAULT` in a single
migration that ships with a Worker deploy — the old Worker doesn't send that
column and every its INSERT fails.

See `docs/runbooks/expand-contract-migrations.md` for worked examples.

## Dependencies

Minor/patch dev-deps are **grouped + auto-merged** (`.github/dependabot.yml`,
`dependabot-auto-merge.yml`). Test majors locally first; close incompatible
ones with `@dependabot ignore this major version` (e.g. ESLint 10 breaks
`eslint-plugin-import`).

## More

Humans: see [`CONTRIBUTING.md`](CONTRIBUTING.md). Specs/state:
`.kiro/specs/athlya-platform/{requirements,design,tasks,PROGRESS}.md`.
