#!/usr/bin/env bash
# =====================================================================
# test-rls.sh — run the pgTAP RLS test suite against a live Postgres.
#
# Prerequisites:
#   * `psql` on PATH (any version ≥ 14 works; CI pins Postgres 17).
#   * `$DATABASE_URL` pointing at a database the caller can create
#     extensions on (the pgtap extension is installed by bootstrap).
#     Neon ephemeral branches and the `pgtap/pgtap` Docker image both
#     work out of the box.
#   * `node` on PATH for the coverage linter.
#
# What this script does:
#   1. Runs `scripts/lint-rls-coverage.mjs` to confirm every policy in
#      `migrations/0001_rls.sql` is referenced by at least one test.
#      A failure here short-circuits before any SQL runs.
#   2. Applies every forward migration (`migrations/*.sql` minus the
#      `*.down.sql` rollbacks) in filename order, like `pgtap.yml`.
#      `ON_ERROR_STOP=1` makes psql exit non-zero on the first error.
#   3. Runs `tests/rls/run-all.sql`, which sources the bootstrap and
#      every per-table test file. Each file wraps its assertions in a
#      `BEGIN; ... ROLLBACK;` pair so the suite is idempotent.
#
# Usage (local, using the pgtap/pgtap Docker image):
#
#   docker run --rm -d --name athlya-pg \
#       -e POSTGRES_PASSWORD=test -p 5432:5432 pgtap/pgtap
#   export DATABASE_URL=postgres://postgres:test@localhost:5432/postgres
#   bash packages/db/scripts/test-rls.sh
#
# Usage (CI): the `db-rls` workflow sets `DATABASE_URL` to the job's
# Postgres service and invokes this script directly.
# =====================================================================

set -euo pipefail

# Resolve the package root so the script works from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PKG_ROOT"

if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "test-rls.sh: DATABASE_URL is not set. Point it at a Postgres instance with pgtap available." >&2
    exit 2
fi

echo "==> [1/3] lint: every policy must be referenced by a test"
node "$PKG_ROOT/scripts/lint-rls-coverage.mjs"

echo "==> [2/3] apply forward migrations in filename order"
for f in $(ls "$PKG_ROOT"/migrations/*.sql | grep -v '\.down\.sql$' | sort); do
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done

echo "==> [3/3] run pgTAP RLS suite (tests/rls/run-all.sql)"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$PKG_ROOT/tests/rls/run-all.sql"

echo "==> RLS pgTAP suite OK"
