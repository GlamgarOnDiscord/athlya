#!/usr/bin/env bash
# Sentry release + source maps for every path that ships a Worker version
# (issues #138, #415).
#
# Usage: bash scripts/sentry-release.sh <prepare|finalize|all> <staging|production>
#
#   prepare   create the release, inject debug ids and upload the source maps
#             wrangler wrote under packages/api/dist (gateway in dist/, each
#             sub-worker in dist/<worker>/), then associate commits. Run it
#             after the bundles are built and BEFORE traffic shifts, so the
#             first events of a canary already de-minify.
#   finalize  mark the release finalized and record a deploy marker for the
#             environment. Run it once the version serves 100 % of traffic.
#   all       prepare + finalize (direct deploys).
#
# The release name is the 7-char commit SHA, identical to the `VERSION` var
# every Worker is deployed with (`--var VERSION:<sha7>`) and tags on each
# captured event (packages/api/src/sentry.ts → event.release); Sentry matches
# uploaded maps to events by release + filename.
#
# Env: SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT, GITHUB_SHA.
# Fail-closed in production: missing Sentry configuration exits 1. Staging
# only warns and skips, so an unprovisioned staging project never blocks.
set -euo pipefail

MODE="${1:-}"
DEPLOY_ENV="${2:-}"

case "${MODE}" in
  prepare | finalize | all) ;;
  *)
    echo "::error::usage: sentry-release.sh <prepare|finalize|all> <staging|production>" >&2
    exit 2
    ;;
esac
case "${DEPLOY_ENV}" in
  staging | production) ;;
  *)
    echo "::error::environment must be staging or production, got '${DEPLOY_ENV}'" >&2
    exit 2
    ;;
esac

missing=()
[ -n "${SENTRY_AUTH_TOKEN:-}" ] || missing+=("SENTRY_AUTH_TOKEN")
[ -n "${SENTRY_ORG:-}" ] || missing+=("SENTRY_ORG")
[ -n "${SENTRY_PROJECT:-}" ] || missing+=("SENTRY_PROJECT")
if [ "${#missing[@]}" -gt 0 ]; then
  if [ "${DEPLOY_ENV}" = "production" ]; then
    echo "::error::${missing[*]} required for production source maps and release tracking (#415)"
    exit 1
  fi
  echo "::warning::${missing[*]} not configured — skipping staging Sentry release (#138)"
  exit 0
fi

if [ -z "${GITHUB_SHA:-}" ]; then
  echo "::error::GITHUB_SHA is not set — cannot derive the Sentry release" >&2
  exit 1
fi
RELEASE="${GITHUB_SHA:0:7}"

# Repository root, so the script works from any working directory.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Pinned CLI (devDependency @sentry/cli, exact version) invoked through pnpm
# so CI runs a lockfile-reviewed artifact rather than a floating npx range
# resolved while the auth token is in the environment. `pnpm --filter
# @athlya/api exec` runs in packages/api, where wrangler wrote --outdir dist.
sentry_cli() {
  (cd "${ROOT}" && pnpm --filter @athlya/api exec sentry-cli "$@")
}

prepare() {
  if [ ! -d "${ROOT}/packages/api/dist" ]; then
    echo "::error::packages/api/dist not found — run wrangler with --outdir dist before uploading source maps"
    exit 1
  fi
  if ! find "${ROOT}/packages/api/dist" -name '*.js.map' -print -quit | grep -q .; then
    echo "::error::no *.js.map under packages/api/dist — check upload_source_maps in wrangler.toml"
    exit 1
  fi
  sentry_cli releases new "${RELEASE}"
  sentry_cli sourcemaps inject dist
  sentry_cli sourcemaps upload --release "${RELEASE}" dist
  sentry_cli releases set-commits "${RELEASE}" --auto --ignore-missing
  echo "::notice::Sentry release ${RELEASE} created with source maps (${DEPLOY_ENV})"
}

finalize() {
  sentry_cli releases finalize "${RELEASE}"
  sentry_cli releases deploys "${RELEASE}" new -e "${DEPLOY_ENV}"
  echo "::notice::Sentry release ${RELEASE} finalized, deploy marker ${DEPLOY_ENV}"
}

case "${MODE}" in
  prepare) prepare ;;
  finalize) finalize ;;
  all)
    prepare
    finalize
    ;;
esac
