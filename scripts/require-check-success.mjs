#!/usr/bin/env node
/**
 * Fail unless a named GitHub check run succeeded on a commit — issue #343.
 *
 * Production deploy phases call this so a commit can only reach
 * production after the staging gate proved that exact SHA.
 *
 * Usage (GitHub Actions):
 *   GITHUB_TOKEN=… node scripts/require-check-success.mjs \
 *     --repo "$GITHUB_REPOSITORY" --sha "$GITHUB_SHA" --check "Staging gate"
 */

import { parseArgs } from 'node:util';

/**
 * Pick the most recent completed run of `checkName` and report whether it
 * succeeded. Pure so it can be unit-tested without the GitHub API.
 *
 * @param {Array<{ name: string, status: string, conclusion: string | null, completed_at: string | null }>} checkRuns
 * @param {string} checkName
 * @returns {{ ok: boolean, reason: string }}
 */
export function evaluateCheckRuns(checkRuns, checkName) {
  const runs = checkRuns
    .filter((run) => run.name === checkName && run.status === 'completed')
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
export async function requireCheckSuccess({ repo, sha, checkName, token, fetchImpl = fetch }) {
  const url = `https://api.github.com/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(checkName)}&per_page=100`;
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

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      sha: { type: 'string' },
      check: { type: 'string' },
    },
  });
  const token = process.env.GITHUB_TOKEN;
  if (!values.repo || !values.sha || !values.check || !token) {
    console.error('[require-check] --repo, --sha, --check and GITHUB_TOKEN are required');
    process.exit(1);
  }
  const { ok, reason } = await requireCheckSuccess({
    repo: values.repo,
    sha: values.sha,
    checkName: values.check,
    token,
  });
  if (!ok) {
    console.error(`::error title=Required check missing::${reason} (${values.sha})`);
    process.exit(1);
  }
  console.log(`[require-check] OK — ${reason}`);
}
