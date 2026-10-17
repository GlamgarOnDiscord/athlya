#!/usr/bin/env node
/**
 * Canary deploy orchestrator — Workers Versions API (issue #129).
 *
 * Usage:
 *   node scripts/canary-deploy.mjs upload --env <staging|production> [--message msg] [--outdir dir]
 *   node scripts/canary-deploy.mjs promote --env <env> --version-id ID --percent N
 *   node scripts/canary-deploy.mjs staging-smoke --base-url URL
 *   node scripts/canary-deploy.mjs production-canary --base-url URL [--staging-url URL] [--wait-min 10] [--steps 5,25,100] [--version-id ID]
 *   node scripts/canary-deploy.mjs rollback --env production [--version-id ID]
 *
 * `upload --outdir dist` keeps the bundle and its source maps (wrangler
 * writes them under packages/api/<dir>) and records `version_id` in
 * $GITHUB_OUTPUT, so the workflow can upload the maps to Sentry before
 * `production-canary --version-id` shifts any traffic (issue #415).
 *
 * Requires: pnpm, wrangler (packages/api), CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in env.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  evaluateErrorBudget,
  fetchReleaseErrorCount,
  readErrorBudgetConfig,
} from './canary-error-budget.mjs';
import { runSmoke } from './smoke-routes.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(ROOT, 'packages', 'api');

const VALID_ENVS = new Set(['staging', 'production']);

function usage(code = 0) {
  console.log(`Usage:
  node scripts/canary-deploy.mjs upload --env staging|production [--message text] [--outdir dir]
  node scripts/canary-deploy.mjs promote --env ENV --version-id ID --percent N
  node scripts/canary-deploy.mjs staging-smoke --base-url URL
  node scripts/canary-deploy.mjs production-canary --base-url URL [--staging-url URL] [--wait-min 10] [--steps 5,25,100] [--version-id ID]
  node scripts/canary-deploy.mjs rollback --env production [--version-id ID]

Runbook: docs/runbooks/canary-deploy.md`);
  process.exit(code);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { command: positional[0], flags, positional: positional.slice(1) };
}

function runWrangler(args, { capture = true } = {}) {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...args], {
    cwd: API_DIR,
    encoding: 'utf8',
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    const err = result.stderr?.trim() || result.stdout?.trim() || `wrangler exit ${result.status}`;
    throw new Error(err);
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function assertEnv(name) {
  if (!VALID_ENVS.has(name)) {
    throw new Error(`Invalid --env "${name}" (expected staging|production)`);
  }
}

function latestVersionId(env) {
  const { stdout } = runWrangler(['versions', 'list', '--env', env, '--json']);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Failed to parse wrangler versions list --json output');
  }
  const versions = Array.isArray(parsed) ? parsed : parsed?.versions;
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error(`No Worker versions returned for env=${env}`);
  }
  const id = versions[0]?.id ?? versions[0]?.version_id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Could not resolve latest version id from versions list');
  }
  return id;
}

function uploadVersion(env, message, outdir) {
  assertEnv(env);
  const msg =
    typeof message === 'string' && message.length > 0
      ? message
      : `canary-${env}-${new Date().toISOString()}`;
  console.log(`Uploading Worker version (${env})…`);
  const args = ['versions', 'upload', '--env', env, '--message', msg, '-y'];
  // wrangler parses `--var KEY:VALUE` (a `=` would create a key named
  // "VERSION=…"). VERSION is the Sentry release the error budget queries.
  if (process.env.VERSION) args.push('--var', `VERSION:${process.env.VERSION}`);
  // Relative to packages/api. Keeps the bundle + *.js.map for Sentry.
  if (typeof outdir === 'string' && outdir.length > 0) args.push('--outdir', outdir);
  runWrangler(args, { capture: false });
  const versionId = latestVersionId(env);
  console.log(`Uploaded version id: ${versionId}`);
  return versionId;
}

function promoteVersion(env, versionId, percent) {
  assertEnv(env);
  const pct = Number(percent);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new Error(`Invalid --percent ${percent}`);
  }
  if (typeof versionId !== 'string' || versionId.length === 0) {
    throw new Error('--version-id is required for promote');
  }
  console.log(`Promoting ${env} version ${versionId} to ${pct}% traffic…`);
  runWrangler(
    [
      'versions',
      'deploy',
      '--env',
      env,
      '--version-id',
      versionId,
      '--percentage',
      String(Math.round(pct)),
      '-y',
    ],
    { capture: false },
  );
}

async function waitHealthReady(baseUrl, maxAttempts = 30, sleepSec = 2) {
  const url = `${baseUrl.replace(/\/$/, '')}/health/ready`;
  console.log(`Polling ${url}…`);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.status === 'ready') {
        console.log(`Ready after attempt ${attempt}/${maxAttempts}`);
        return;
      }
      console.log(
        `attempt ${attempt}/${maxAttempts}: HTTP ${res.status} status=${body?.status ?? 'unknown'}`,
      );
    } catch (err) {
      console.log(
        `attempt ${attempt}/${maxAttempts}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (attempt < maxAttempts) {
      await sleep(sleepSec * 1000);
    }
  }
  throw new Error(`/health/ready not ready after ${maxAttempts} attempts`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rollback(env, versionId) {
  assertEnv(env);
  const args = ['rollback', '--env', env, '-y', '-m', 'canary-deploy rollback (issue #129)'];
  if (typeof versionId === 'string' && versionId.length > 0) {
    args.push(versionId);
  }
  console.log(`Rolling back ${env}…`);
  runWrangler(args, { capture: false });
}

async function stagingSmoke(baseUrl) {
  if (!baseUrl) throw new Error('--base-url is required');
  const versionId = uploadVersion('staging', `staging-smoke-${Date.now()}`);
  await waitHealthReady(baseUrl);
  console.log(JSON.stringify({ phase: 'staging-smoke', versionId, baseUrl }));
  return versionId;
}

/**
 * Poll /health/ready once per minute during the canary bake window.
 * Returns the number of consecutive readiness failures seen (≥ 2 → abort).
 * Issue #415: gates on live health signal instead of a blind sleep.
 */
async function monitorCanaryWindow(baseUrl, waitMs) {
  const pollIntervalMs = 60_000;
  const polls = Math.max(1, Math.floor(waitMs / pollIntervalMs));
  let consecutiveFailures = 0;

  for (let i = 1; i <= polls; i++) {
    await sleep(Math.min(pollIntervalMs, waitMs / polls));
    const url = `${baseUrl.replace(/\/$/, '')}/health/ready`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.status === 'ready') {
        consecutiveFailures = 0;
        console.log(`canary monitor [${i}/${polls}]: ready`);
      } else {
        consecutiveFailures++;
        console.warn(
          `canary monitor [${i}/${polls}]: HTTP ${res.status} status=${body?.status ?? 'unknown'} (failure #${consecutiveFailures})`,
        );
      }
    } catch (err) {
      consecutiveFailures++;
      console.warn(
        `canary monitor [${i}/${polls}]: ${err instanceof Error ? err.message : String(err)} (failure #${consecutiveFailures})`,
      );
    }
    if (consecutiveFailures >= 2) {
      return consecutiveFailures;
    }
  }
  return consecutiveFailures;
}

/**
 * Route reachability after a traffic shift: every route group answers
 * without a 5xx. At a partial percentage most of these requests still land
 * on the previous version, so this proves the fleet is reachable, not that
 * the canary is healthy — the release-tagged error budget does that.
 *
 * Unauthenticated on purpose: production login sits behind Turnstile,
 * whose tokens are single-use and cannot be minted by CI. The
 * authenticated route smoke runs on staging (staging-gate.yml).
 */
async function reachabilityOrThrow(baseUrl, label) {
  const { ok, failures } = await runSmoke({ baseUrl });
  if (!ok) {
    throw new Error(`Route reachability failed at ${label}: ${failures.join('; ')}`);
  }
}

async function errorBudgetOrThrow(budget, windowStart, label) {
  const errorCount = await fetchReleaseErrorCount({
    org: budget.org,
    project: budget.project,
    release: budget.release,
    token: budget.token,
    start: windowStart,
    end: new Date(),
  });
  const { ok, reason } = evaluateErrorBudget({ errorCount, maxErrors: budget.maxErrors });
  console.log(`error budget at ${label}: ${reason}`);
  if (!ok) {
    throw new Error(`Canary aborted at ${label}: ${reason}`);
  }
}

/**
 * Tell the workflow the gateway now serves this version, so a later failure
 * rolls it back (and an earlier one leaves the live deployment alone).
 */
function markPromoted() {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'promoted=true\n');
}

async function productionCanary({ baseUrl, stagingUrl, waitMin, steps, versionId: uploadedId }) {
  if (!baseUrl) throw new Error('--base-url is required');
  const budgetConfig = readErrorBudgetConfig(process.env);
  if (!budgetConfig.ok) {
    const problems = [
      ...(budgetConfig.missing.length > 0 ? [`missing ${budgetConfig.missing.join(', ')}`] : []),
      ...budgetConfig.invalid.map((entry) => `invalid ${entry}`),
    ];
    throw new Error(`Canary needs a live error signal; ${problems.join('; ')} (issue #404)`);
  }
  const budget = budgetConfig.config;
  const waitMinutes = Number.isFinite(waitMin) && waitMin > 0 ? waitMin : 10;
  if (stagingUrl) {
    console.log('Pre-flight: staging /health/ready…');
    await waitHealthReady(stagingUrl);
  }
  // A version uploaded by an earlier step (whose source maps already reached
  // Sentry) is promoted as is; otherwise upload one now.
  const versionId =
    typeof uploadedId === 'string' && uploadedId.length > 0
      ? uploadedId
      : uploadVersion('production', `production-canary-${budget.release}`);
  const waitMs = waitMinutes * 60 * 1000;

  // Every step, 100 % included, gets the bake window and the error budget:
  // full promotion is only reported once the release has held at 100 %.
  for (const pct of steps) {
    promoteVersion('production', versionId, pct);
    markPromoted();
    const windowStart = new Date();
    await reachabilityOrThrow(baseUrl, `${pct}%`);
    console.log(`Monitoring ${waitMinutes} min at ${pct}% — polling /health/ready every 60 s…`);
    const failures = await monitorCanaryWindow(baseUrl, waitMs);
    if (failures >= 2) {
      throw new Error(
        `Canary aborted at ${pct}%: /health/ready failed ${failures} times consecutively. ` +
          'Run: node scripts/canary-deploy.mjs rollback --env production',
      );
    }
    await errorBudgetOrThrow(budget, windowStart, `${pct}%`);
  }

  await waitHealthReady(baseUrl);
  console.log(
    JSON.stringify({
      phase: 'production-canary',
      versionId,
      release: budget.release,
      steps,
      baseUrl,
    }),
  );
  return versionId;
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!command) usage(2);

  switch (command) {
    case 'upload': {
      if (!flags.env) throw new Error('--env is required');
      if (flags.outdir === true) throw new Error('--outdir needs a directory');
      const id = uploadVersion(flags.env, flags.message, flags.outdir);
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, `version_id=${id}\n`);
      console.log(id);
      break;
    }
    case 'promote': {
      if (!flags.env) throw new Error('--env is required');
      if (!flags['version-id']) throw new Error('--version-id is required');
      if (flags.percent === undefined || flags.percent === true) {
        throw new Error('--percent is required');
      }
      promoteVersion(flags.env, flags['version-id'], flags.percent);
      break;
    }
    case 'staging-smoke':
      await stagingSmoke(flags['base-url']);
      break;
    case 'production-canary': {
      const steps = (flags.steps ?? '5,25,100')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (steps.length === 0 || steps[steps.length - 1] !== 100) {
        throw new Error('--steps must end with 100 (e.g. 5,25,100)');
      }
      const rawWaitMin = Number(flags['wait-min'] ?? 10);
      const waitMin = Number.isFinite(rawWaitMin) && rawWaitMin > 0 ? rawWaitMin : 10;
      if (flags['version-id'] === true) throw new Error('--version-id needs a value');
      await productionCanary({
        baseUrl: flags['base-url'],
        stagingUrl: flags['staging-url'],
        waitMin,
        steps,
        versionId: flags['version-id'],
      });
      break;
    }
    case 'rollback':
      rollback(flags.env ?? 'production', flags['version-id']);
      break;
    default:
      usage(2);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
