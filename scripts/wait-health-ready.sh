#!/usr/bin/env bash
# Poll /health/ready until the API reports ready or timeout (issue #71).
#
# Usage:
#   bash scripts/wait-health-ready.sh <base-url> [max-attempts] [sleep-seconds]
#
# Examples:
#   bash scripts/wait-health-ready.sh https://api.athlya.app
#   bash scripts/wait-health-ready.sh https://staging.api.athlya.app 30 2
#
# Exit codes:
#   0 — readiness OK (HTTP 200, body.status == ready)
#   1 — not ready after all attempts or non-200
#   2 — usage error

set -euo pipefail

BASE_URL="${1:-}"
MAX_ATTEMPTS="${2:-30}"
SLEEP_SEC="${3:-2}"

if [[ -z "${BASE_URL}" ]]; then
  echo "Usage: bash scripts/wait-health-ready.sh <base-url> [max-attempts] [sleep-seconds]" >&2
  exit 2
fi

BASE_URL="${BASE_URL%/}"
READY_URL="${BASE_URL}/health/ready"

echo "Polling ${READY_URL} (max ${MAX_ATTEMPTS} attempts, ${SLEEP_SEC}s apart)..."

for attempt in $(seq 1 "${MAX_ATTEMPTS}"); do
  if response="$(curl -sf "${READY_URL}" 2>/dev/null)"; then
    status="$(printf '%s' "${response}" | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
    if [[ "${status}" == "ready" ]]; then
      echo "OK — ready after attempt ${attempt}/${MAX_ATTEMPTS}"
      printf '%s\n' "${response}"
      exit 0
    fi
    echo "attempt ${attempt}/${MAX_ATTEMPTS}: HTTP 200 but status=${status:-unknown}"
  else
    code="$(curl -s -o /tmp/athlya-ready-body.json -w '%{http_code}' "${READY_URL}" || true)"
    echo "attempt ${attempt}/${MAX_ATTEMPTS}: HTTP ${code:-error}"
    if [[ -f /tmp/athlya-ready-body.json ]]; then
      cat /tmp/athlya-ready-body.json
      echo
    fi
  fi
  if [[ "${attempt}" -lt "${MAX_ATTEMPTS}" ]]; then
    sleep "${SLEEP_SEC}"
  fi
done

echo "FAIL — /health/ready not ready after ${MAX_ATTEMPTS} attempts" >&2
exit 1
