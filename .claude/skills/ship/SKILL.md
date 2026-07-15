---
name: ship
description: >-
  Athlya end-to-end change workflow: GitHub issue → branch → EPCT → local
  preflight → PR → CI → MANDATORY AI bot-review pass → merge (all checks
  green) → docs. Use for ANY code/config/docs change on this repo so red-CI
  round-trips and skipped reviews never happen. Triggers when the user asks
  to implement a fix/feature/chore, land WIP, or process PRs/issues.
---

# /ship — Athlya change workflow

The single loop for landing any change on `GlamgarOnDiscord/athlya`. Follow
every step in order. The two ⭐ steps are the ones that previously caused pain
(red-CI round-trips, merging over reviews) — never skip them.

## 0. Decide scope first

- One concern = one PR. **Split mixed working-tree WIP into focused PRs**
  (security / hardening / cleanup separately) rather than one mega-PR.
- Batch only homogeneous low-risk things (e.g. dependency bumps).

## 1. Issue

- Create a GitHub issue with a **detailed** body (context, repro, fix plan,
  acceptance criteria) for any feature / fix / security / non-trivial change.
- **Skip the issue only for trivial chores** (formatting, lockfile sync, typo)
  — those go straight to a clearly-titled PR.
- Labels exist: `security`, `infra`, `performance`, `compliance`, `area: *`,
  `priority: *`, `enhancement`, `bug`. Use them.

## 2. Read issue + codebase (EPCT explore)

Understand the real shape before touching anything.

## 3. Branch

`fix/issue-XX-…` · `feat/…` · `chore/…` off up-to-date `master`.

## 4. Implement (EPCT: explore → plan → code → test)

- Match surrounding code style. Code/comments/identifiers in **English**.
- No scaffolding comments. No Claude attribution in commits; commit with the
  repo's configured git identity (`git config user.name` / `user.email`).
- Add/adjust tests for new logic.

## 5. ⭐ Local preflight (BEFORE pushing)

```
pnpm preflight        # = install --frozen-lockfile && format:check && lint && typecheck && test && build:ci
```

This mirrors the required CI job's fast gates exactly (~38s, Turbo-cached).
The `.githooks/pre-push` hook runs it automatically on push — let it.

- `format:check` is **repo-wide** (`prettier --check "**/*"`): any unformatted
  tracked file fails it. Run `pnpm format` to fix.
- Dropped a dep? `pnpm install` to sync the lockfile (CI uses `--frozen-lockfile`).
- Gotcha: `res.json()` in `packages/api` tests — typescript-eslint sees `any`,
  tsc (WebWorker + workers-types) sees `unknown`. Use the `readJson<T>(res)`
  helper, not an inline `as T`.

## 6. Commit + push + PR

- Clean conventional commits. PR body links the issue with `Closes #XX`.

## 7. CI

- Required check: **`Lint, typecheck, and tests`**. Also runs (by path):
  pgTAP (`packages/db/migrations/**`), CodeQL, ZAP, secret-scan, Socket,
  axe/E2E (`apps/**`), Docker PBT.
- Watch with the **`Monitor` tool**, never `sleep`. Use this poll loop so
  every terminal check emits a line and `ALL-CONCLUDED` fires when every
  check has left `pending`:
  ```bash
  prev=""
  while true; do
    s=$(gh pr checks <n> --json name,bucket 2>/dev/null || echo "[]")
    cur=$(echo "$s" | jq -r '.[] | select(.bucket!="pending") | "\(.name): \(.bucket)"' | sort)
    diff_lines=$(comm -13 <(echo "$prev") <(echo "$cur") 2>/dev/null)
    [ -n "$diff_lines" ] && echo "$diff_lines"
    prev="$cur"
    echo "$s" | jq -e 'length > 0 and all(.bucket!="pending")' >/dev/null && echo "ALL-CONCLUDED" && break
    sleep 30
  done
  ```
- CI red:
  - Real failure → fix locally (re-run preflight) → push.
  - Known flake (Docker registry timeout; `round-trip` property seed flake)
    → `gh run rerun <id> --failed`, don't change code.

## 8. ⭐ MANDATORY — AI bot reviews after EVERY push and before merge/close

- Bots re-review on every new commit. **Read reviews after each push**,
  not only at the end — Copilot / CodeRabbit can raise new issues on a
  fix commit that change what needs to be done before merge.
- Fetch ALL feedback (CodeRabbit, cubic, Copilot), not just inline.
  Check the commit SHA on each comment to know if it's old or new:
  - inline (with commit id): `gh api repos/GlamgarOnDiscord/athlya/pulls/<n>/comments --jq '[.[] | {commit: .commit_id[:8], login: .user.login, body: .body[:200]}]'`
  - PR conversation (CodeRabbit summary lives here):
    `gh api repos/GlamgarOnDiscord/athlya/issues/<n>/comments`
  - review bodies: `gh pr view <n> --json reviews`
- **Read ALL comments. Apply the good ones** (security / bugs / perf /
  correctness / consistency) in a follow-up commit. Skip only true false
  positives, and say why.
- After applying: re-run preflight → push → re-read reviews on the new
  commit → resolve threads via GraphQL `resolveReviewThread` (else
  `required_conversation_resolution` blocks merge).
- **Never merge over an unaddressed actionable bot comment.**

## 9. Merge (wait for ALL checks green)

- Branch protection: only `Lint, typecheck, and tests` is _required_;
  `enforce_admins: false`, `required_conversation_resolution: true`, strict on.
- **Policy: wait for ALL checks green** (pgTAP / axe / CodeQL / ZAP too), not
  just the required one.
- Default merge: `gh pr merge <n> --squash --delete-branch`. Add `--admin`
  **only** to bypass a check that is a _proven_ flake — never as the default.
- Verify the green run's head sha == PR HEAD first.
- Issue auto-closes via `Closes #XX`.

## 10. After merge

- Update `.kiro/.../PROGRESS.md` + `tasks.md` when the work maps to a kiro task.
- Update project memory if a durable, non-obvious fact emerged.

## Dependency PRs (dependabot)

- Safe minor/patch dev-deps are **grouped + auto-merged** (see
  `.github/dependabot.yml` + `dependabot-auto-merge.yml`).
- **Majors are isolated**: test locally first. If a plugin/runtime breaks
  (e.g. ESLint 10 ✗ eslint-plugin-import; @types/node 25 ✗ Node-20 pin),
  close with a concrete rationale + `@dependabot ignore this major version`.

## Quick reference

| Need           | Command                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| Pre-push gate  | `pnpm preflight`                                                                                           |
| Watch CI       | `Monitor` tool (not sleep)                                                                                 |
| Rerun flake    | `gh run rerun <id> --failed`                                                                               |
| Bot reviews    | inline `.../pulls/<n>/comments` + conversation `.../issues/<n>/comments` + `gh pr view <n> --json reviews` |
| Resolve thread | GraphQL `resolveReviewThread`                                                                              |
| Merge          | `gh pr merge <n> --squash --delete-branch` (all green; `--admin` only for a proven flake)                  |
