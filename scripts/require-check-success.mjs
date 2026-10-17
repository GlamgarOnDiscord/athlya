#!/usr/bin/env node
/**
 * Fail unless a named GitHub check run succeeded on a commit — issue #343.
 *
 * Production deploy phases call this so a commit can only reach
 * production after the staging gate proved that exact SHA, including the
 * full 10-minute k6 soak ("Staging gate (full soak)").
 *
 * Usage (GitHub Actions) — `--check` may be repeated; every check must pass:
 *   GITHUB_TOKEN=… node scripts/require-check-success.mjs \
 *     --repo "$GITHUB_REPOSITORY" --sha "$GITHUB_SHA" \
 *     --check "Staging gate" --check "Staging gate (full soak)"
 *
 * `--any-check` (also repeatable) adds one alternative group: at least one
 * of its checks must pass, e.g. a staging frontend deploy of all apps or of
 * the one app being shipped (issue #422):
 *   … --any-check "deploy all (staging)" --any-check "deploy web (staging)"
 * `--check` and `--any-check` combine: every `--check` and one `--any-check`.
 */

import { parseArgs } from 'node:util';

/**
 * Pick the most recent completed run of `checkName` and report whether it
 * succeeded. Skipped runs prove nothing either way (e.g. the full-soak job
 * of a short manual staging-gate run), so they are ignored. Pure so it can
 * be unit-tested without the GitHub API.
 *
 * @param {Array<{ name: string, status: string, conclusion: string | null, completed_at: string | null }>} checkRuns
 * @param {string} checkName
 * @returns {{ ok: boolean, reason: string }}
 */
export function evaluateCheckRuns(checkRuns, checkName) {
  const runs = checkRuns
    .filter(
      (run) => run.name === checkName && run.status === 'completed' && run.conclusion !== 'skipped',
    )
    .sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));
  const latest = runs[0];
  if (!latest) {
    return { ok: false, reason: `no completed "${checkName}" check run on this commit` };
  }
  if (latest.conclusion !== 'success') {
    return { ok: false, reason: `latest "${checkName}" run concluded "${latest.conclusion}"` };
  }
  return { ok: true, reason: `"${checkName}" succeeded at ${latest.completed_at}` };
}

/**
 * @param {{ repo: string, sha: string, checkName: string, token: string, fetchImpl?: typeof fetch }} options
 */
// `filter=all`: the API defaults to `latest`, which can return only the
// newest run and hide an earlier success behind a later skipped run.
export async function requireCheckSuccess({ repo, sha, checkName, token, fetchImpl = fetch }) {
  const url = `https://api.github.com/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(checkName)}&filter=all&per_page=100`;
  const res = await fetchImpl(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) {
    return { ok: false, reason: `GitHub API returned ${res.status}` };
  }
  const body = await res.json();
  return evaluateCheckRuns(body.check_runs ?? [], checkName);
}

/**
 * Every `all` check must pass; when `any` is non-empty, at least one of its
 * checks must pass too. Pure so the combination is unit-testable.
 *
 * @param {{ all: string[], any: string[] }} required
 * @param {(checkName: string) => Promise<{ ok: boolean, reason: string }>} check
 * @returns {Promise<{ ok: boolean, passed: string[], failures: string[] }>}
 */
export async function evaluateRequirements({ all, any }, check) {
  const passed = [];
  const failures = [];
  for (const checkName of all) {
    const { ok, reason } = await check(checkName);
    (ok ? passed : failures).push(reason);
  }
  if (any.length > 0) {
    const anyReasons = [];
    let anyPassed = false;
    for (const checkName of any) {
      const { ok, reason } = await check(checkName);
      if (ok) {
        passed.push(reason);
        anyPassed = true;
        break;
      }
      anyReasons.push(reason);
    }
    if (!anyPassed) failures.push(`none of the alternatives passed: ${anyReasons.join('; ')}`);
  }
  return { ok: failures.length === 0, passed, failures };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      sha: { type: 'string' },
      check: { type: 'string', multiple: true },
      'any-check': { type: 'string', multiple: true },
    },
  });
  const token = process.env.GITHUB_TOKEN;
  const all = values.check ?? [];
  const any = values['any-check'] ?? [];
  if (!values.repo || !values.sha || all.length + any.length === 0 || !token) {
    console.error(
      '[require-check] --repo, --sha, --check or --any-check, and GITHUB_TOKEN are required',
    );
    process.exit(1);
  }
  const { ok, passed, failures } = await evaluateRequirements({ all, any }, (checkName) =>
    requireCheckSuccess({ repo: values.repo, sha: values.sha, checkName, token }),
  );
  for (const reason of passed) console.log(`[require-check] OK — ${reason}`);
  for (const reason of failures) {
    console.error(`::error title=Required check missing::${reason} (${values.sha})`);
  }
  if (!ok) process.exit(1);
}
