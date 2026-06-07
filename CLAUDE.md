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
7. **Merge** only when **ALL** checks are green (`--admin` only for a _proven_
   flake): `gh pr merge <n> --squash --admin --delete-branch`.

Watch CI with the **`Monitor`** tool, never `sleep`. Rerun known flakes
(Docker registry timeout, `round-trip` property seed) with `gh run rerun <id> --failed`.

## Hard rules

- Code, comments, identifiers, commits: **English only**. No scaffolding comments.
- Commits: conventional, **no Claude attribution**; use `tomcoudrieau@gmail.com`.
- Node 20 (`.nvmrc`, `engines`). pnpm ≥ 9. Don't bump `@types/node` past 20.
- `format:check` is repo-wide — keep every tracked file prettier-clean.
- In `packages/api` tests, read responses with the `readJson<T>(res)` helper,
  not an inline `(await res.json()) as T` (typescript-eslint vs tsc disagree).
- Only `Lint, typecheck, and tests` is a required check; pgTAP runs on
  `packages/db/migrations/**`, axe/E2E on `apps/**`.

## Dependencies

Minor/patch dev-deps are **grouped + auto-merged** (`.github/dependabot.yml`,
`dependabot-auto-merge.yml`). Test majors locally first; close incompatible
ones with `@dependabot ignore this major version` (e.g. ESLint 10 breaks
`eslint-plugin-import`).

## More

Humans: see [`CONTRIBUTING.md`](CONTRIBUTING.md). Specs/state:
`.kiro/specs/athlya-platform/{requirements,design,tasks,PROGRESS}.md`.
