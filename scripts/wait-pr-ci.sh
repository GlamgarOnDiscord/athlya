#!/usr/bin/env bash
# Wait for all GitHub PR checks to finish, then announce VERT or ROUGE.
#
# Usage:
#   bash scripts/wait-pr-ci.sh <pr-number|pr-url> [interval-seconds]
#
# Examples:
#   bash scripts/wait-pr-ci.sh 87
#   bash scripts/wait-pr-ci.sh https://github.com/GlamgarOnDiscord/athlya/pull/87 20
#
# Exit codes:
#   0 — finished, all checks pass (skipping ignored)
#   1 — finished, at least one fail/cancel
#   8 — still pending when watch ends unexpectedly
#   2 — usage / gh error

set -euo pipefail

PR_REF="${1:-}"
INTERVAL="${2:-30}"

if [[ -z "${PR_REF}" ]]; then
  echo "Usage: bash scripts/wait-pr-ci.sh <pr-number|pr-url> [interval-seconds]" >&2
  exit 2
fi

if ! command -v gh >/dev/null 2>&1; then
  for candidate in \
    "/c/Program Files/GitHub CLI/gh.exe" \
    "${LOCALAPPDATA}/Programs/GitHub CLI/gh.exe" \
    "/mnt/c/Program Files/GitHub CLI/gh.exe"; do
    if [[ -x "${candidate}" ]]; then
      GH_BIN="${candidate}"
      break
    fi
  done
  if [[ -z "${GH_BIN:-}" ]]; then
    echo "ERROR: gh CLI required (install: https://cli.github.com/)" >&2
    exit 2
  fi
else
  GH_BIN="gh"
fi

gh() {
  "${GH_BIN}" "$@"
}

PR_NUMBER="$(gh pr view "${PR_REF}" --json number --jq '.number')"
PR_URL="$(gh pr view "${PR_NUMBER}" --json url --jq '.url')"
BRANCH="$(gh pr view "${PR_NUMBER}" --json headRefName --jq '.headRefName')"

echo "=== CI watcher ==="
echo "PR #${PR_NUMBER}: ${PR_URL}"
echo "Branch: ${BRANCH}"
echo "Interval: ${INTERVAL}s"
echo ""

set +e
gh pr checks "${PR_NUMBER}" --watch --interval "${INTERVAL}"
WATCH_EXIT=$?
set -e

PENDING="$(gh pr checks "${PR_NUMBER}" --json bucket --jq '[.[] | select(.bucket == "pending")] | length')"
FAIL_COUNT="$(gh pr checks "${PR_NUMBER}" --json bucket --jq '[.[] | select(.bucket == "fail" or .bucket == "cancel")] | length')"

echo ""

if [[ "${PENDING}" != "0" ]]; then
  echo "========================================"
  echo "  CI INCOMPLETE — EN COURS"
  echo "========================================"
  gh pr checks "${PR_NUMBER}" || true
  exit 8
fi

if [[ "${FAIL_COUNT}" != "0" ]]; then
  echo "========================================"
  echo "  CI FINISHED — ROUGE"
  echo "========================================"
  gh pr checks "${PR_NUMBER}" --json name,bucket,link --jq \
    '.[] | select(.bucket == "fail" or .bucket == "cancel") | "  FAIL  \(.name)\n        \(.link)"'
  echo ""
  gh pr checks "${PR_NUMBER}" || true
  exit 1
fi

echo "========================================"
echo "  CI FINISHED — VERT"
echo "========================================"
gh pr checks "${PR_NUMBER}" || true
exit 0
