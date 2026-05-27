#!/usr/bin/env bash
# Install a GitHub Actions self-hosted runner for Athlya (Linux / WSL2).
#
# Prerequisites (inside WSL2 Ubuntu):
#   - Docker running (required for pgTAP / EXPLAIN service containers)
#   - git, curl, tar
#
# Usage:
#   export GITHUB_RUNNER_TOKEN='<one-time token from GitHub UI>'
#   ./scripts/setup-self-hosted-runner.sh
#
# Token: repo → Settings → Actions → Runners → New self-hosted runner → Linux → x64

set -euo pipefail

REPO="${GITHUB_REPOSITORY:-GlamgarOnDiscord/athlya}"
RUNNER_NAME="${GITHUB_RUNNER_NAME:-$(hostname)-linux}"
RUNNER_DIR="${GITHUB_RUNNER_DIR:-$HOME/actions-runner-athlya}"
LABELS="${GITHUB_RUNNER_LABELS:-self-hosted,Linux,X64}"

if [[ -z "${GITHUB_RUNNER_TOKEN:-}" ]]; then
  echo "Set GITHUB_RUNNER_TOKEN (one-time registration token from GitHub UI)." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker must be installed and running (pgTAP / Postgres service jobs)." >&2
  exit 1
fi

RUNNER_VERSION="$(
  curl -fsSL https://api.github.com/repos/actions/runner/releases/latest |
    grep -Eo '"tag_name": "v[^"]+"' |
    head -n1 |
    cut -d'"' -f4 |
    sed 's/^v//'
)"

mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"

ARCH="x64"
curl -fsSL -o "actions-runner-linux-${ARCH}-${RUNNER_VERSION}.tar.gz" \
  "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${ARCH}-${RUNNER_VERSION}.tar.gz"
tar xzf "actions-runner-linux-${ARCH}-${RUNNER_VERSION}.tar.gz"

./config.sh \
  --url "https://github.com/${REPO}" \
  --token "$GITHUB_RUNNER_TOKEN" \
  --name "$RUNNER_NAME" \
  --labels "$LABELS" \
  --unattended \
  --replace

sudo ./svc.sh install
sudo ./svc.sh start

echo "Runner '${RUNNER_NAME}' registered with labels: ${LABELS}"
echo "Verify: GitHub → ${REPO} → Settings → Actions → Runners (Idle)."
