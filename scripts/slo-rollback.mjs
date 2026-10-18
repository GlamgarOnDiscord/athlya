#!/usr/bin/env node
/**
 * Automatic rollback of the production Worker fleet on a sustained SLO
 * breach — CN.7.3 (issue #632). Driven by .github/workflows/slo-rollback.yml.
 *
 * Usage:
 *   node scripts/slo-rollback.mjs check    [--report file]
 *   node scripts/slo-rollback.mjs plan     --out plan.json [--report file]
 *   node scripts/slo-rollback.mjs rollback --plan plan.json [--reason text] [--report file]
 *
 *   check     re-queries Axiom (never the alert payload) and reports
 *             `breached=true|false` in $GITHUB_OUTPUT. A query failure exits 1.
 *   plan      reads `wrangler deployments list --json` and `wrangler versions
 *             view --json` for every production Worker plus the git history
 *             between the two releases, and reports `action=rollback|noop|refuse`.
 *   rollback  re-validates the live deployments against the plan, then
 *             redeploys each Worker's previous version at 100 % with
 *             `wrangler versions deploy` (gateway first) and verifies it.
 *
 * `wrangler versions deploy` is used instead of `wrangler rollback`: in CI
 * `wrangler rollback -y` silently forces through Cloudflare's "secrets have
 * changed" refusal (API code 10220), while `versions deploy` never forces
 * it, so a secret rotation the planner missed still fails closed.
 *
 * Env: AXIOM_QUERY_TOKEN, AXIOM_SPANS_DATASET, AXIOM_URL (optional) for
 * `check`; CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID for `plan` / `rollback`.
 * Runbook: docs/runbooks/automatic-rollback.md
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(ROOT, 'packages', 'api');

/**
 * Decision thresholds. infra/terraform/axiom-monitors.tf alerts on the same
 * values (asserted by scripts/__tests__/slo-rollback.test.mjs).
 */
export const SLO_ROLLBACK = Object.freeze({
  /** Every one-minute bin of this window must breach. */
  windowMinutes: 10,
  /** Estimated requests per bin below which a bin cannot count as a breach. */
  minRequestsPerBin: 20,
  /** Sampled non-5xx spans per bin below which the p99 is not judged. */
  minLatencySamplesPerBin: 20,
  /** 5xx share of requests, in percent. */
  maxErrorRatePct: 2,
  /** p99 request latency, in milliseconds. */
  maxP99Ms: 2000,
  /** No second automatic rollback within this many minutes of any rollback. */
  cooldownMinutes: 60,
  /** Releases older than this are left to a human. */
  maxDeploymentAgeHours: 24,
});

/**
 * The production bulkhead set, in rollback order: the gateway first so no
 * request reaches a sub-worker contract the gateway no longer serves, then
 * the sub-workers in the reverse of their deploy order.
 */
export const PRODUCTION_WORKERS = Object.freeze([
  { name: 'gateway', config: 'wrangler.toml' },
  { name: 'billing', config: 'wrangler.billing.toml' },
  { name: 'reservations', config: 'wrangler.reservations.toml' },
  { name: 'auth', config: 'wrangler.auth.toml' },
]);

export const CONTRACT_MARKER = /^--\s*athlya:contract\b/m;
export const MIGRATIONS_DIR = 'packages/db/migrations';

const MINUTE_MS = 60_000;
const RELEASE_RE = /^[0-9a-f]{7,40}$/;

/* ------------------------------------------------------------------ */
/*  Breach check                                                       */
/* ------------------------------------------------------------------ */

/**
 * `OTEL_SAMPLE_RATE` of `[env.<env>.vars]` in packages/api/wrangler.toml.
 * Non-5xx spans are exported at this rate, 5xx spans always.
 *
 * @param {string} toml
 * @param {string} env
 * @returns {number} the rate, or NaN when missing or out of (0, 1]
 */
export function readOtelSampleRate(toml, env) {
  const section = toml.split(`[env.${env}.vars]`)[1]?.split(/\n\[/)[0] ?? '';
  const raw = /^\s*OTEL_SAMPLE_RATE\s*=\s*"([\d.]+)"/m.exec(section)?.[1];
  const rate = Number(raw);
  return raw !== undefined && rate > 0 && rate <= 1 ? rate : Number.NaN;
}

/**
 * Per-minute request volume, 5xx share and p99 latency over the spans
 * dataset, with the same span filter and sampling correction as the
 * `api_5xx_rate` SLO monitor.
 *
 * The p99 only covers non-5xx spans. Those are sampled uniformly at
 * `sampleRate`, so their percentile is unbiased. 5xx spans are always kept,
 * so mixing them in would over-weight errors (often slow timeouts) and
 * inflate the p99. Errors are judged by the 5xx share instead.
 *
 * @param {{ dataset: string, sampleRate: number }} input
 */
export function buildBreachQuery({ dataset, sampleRate }) {
  if (!/^[A-Za-z0-9._-]+$/.test(dataset)) throw new Error(`Invalid dataset name "${dataset}"`);
  if (!(sampleRate > 0 && sampleRate <= 1)) throw new Error(`Invalid sample rate ${sampleRate}`);
  return [
    `['${dataset}']`,
    `| where not(name contains " /health")`,
    `| summarize total = count(), errors = countif(['status.code'] == "ERROR"), ok_samples = countif(['status.code'] != "ERROR"), p99_ms = percentileif(duration, 99, ['status.code'] != "ERROR") / 1ms by bin(_time, 1m)`,
    `| extend requests = todouble(errors) + todouble(total - errors) / ${sampleRate}`,
    `| extend rate_pct = 100.0 * todouble(errors) / requests`,
    `| project _time, requests, rate_pct, ok_samples, p99_ms`,
  ].join('\n');
}

/**
 * The evaluation window: `windowMinutes` whole minutes ending one minute
 * before `now`, so the bin still being ingested is never judged.
 *
 * @param {Date} now
 * @param {number} windowMinutes
 */
export function evaluationWindow(now, windowMinutes) {
  const end = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS - MINUTE_MS;
  return { start: new Date(end - windowMinutes * MINUTE_MS), end: new Date(end) };
}

/**
 * Rows of the first table of an Axiom `format=tabular` response.
 *
 * @param {unknown} body
 * @returns {Record<string, unknown>[]}
 */
export function parseTabular(body) {
  const table = /** @type {any} */ (body)?.tables?.[0];
  const fields = table?.fields;
  const columns = table?.columns;
  if (!Array.isArray(fields) || !Array.isArray(columns) || fields.length !== columns.length) {
    throw new Error('Unexpected Axiom response: no tabular result');
  }
  const length = columns[0]?.length ?? 0;
  if (!columns.every((column) => Array.isArray(column) && column.length === length)) {
    throw new Error('Unexpected Axiom response: ragged columns');
  }
  return Array.from({ length }, (_, row) =>
    Object.fromEntries(fields.map((field, i) => [field?.name, columns[i][row]])),
  );
}

/**
 * A breach is sustained only when EVERY minute of the window has enough
 * traffic and breaches the same SLO. A missing bin, a quiet bin or a
 * non-numeric value is not a breach.
 *
 * @param {Record<string, unknown>[]} rows
 * @param {{ start: Date, windowMinutes: number, minRequestsPerBin: number, minLatencySamplesPerBin: number, maxErrorRatePct: number, maxP99Ms: number }} options
 * @returns {{ breached: boolean, signals: string[], reason: string, bins: { time: string, requests: number, ratePct: number, okSamples: number, p99Ms: number }[] }}
 */
export function evaluateBreach(rows, options) {
  const byMinute = new Map();
  for (const row of rows) {
    const time = Date.parse(String(row._time));
    if (Number.isFinite(time)) byMinute.set(Math.floor(time / MINUTE_MS) * MINUTE_MS, row);
  }
  const bins = [];
  for (let i = 0; i < options.windowMinutes; i++) {
    const minute = options.start.getTime() + i * MINUTE_MS;
    const row = byMinute.get(minute);
    bins.push({
      time: new Date(minute).toISOString(),
      requests: Number(row?.requests ?? Number.NaN),
      ratePct: Number(row?.rate_pct ?? Number.NaN),
      okSamples: Number(row?.ok_samples ?? Number.NaN),
      p99Ms: Number(row?.p99_ms ?? Number.NaN),
    });
  }
  const busy = (bin) => Number.isFinite(bin.requests) && bin.requests >= options.minRequestsPerBin;
  const checks = {
    error_rate: (bin) =>
      busy(bin) && Number.isFinite(bin.ratePct) && bin.ratePct > options.maxErrorRatePct,
    latency_p99: (bin) =>
      busy(bin) &&
      Number.isFinite(bin.okSamples) &&
      bin.okSamples >= options.minLatencySamplesPerBin &&
      Number.isFinite(bin.p99Ms) &&
      bin.p99Ms > options.maxP99Ms,
  };
  const signals = Object.entries(checks)
    .filter(([, breaches]) => bins.every(breaches))
    .map(([name]) => name);
  const window = `${options.windowMinutes} consecutive minutes`;
  const reason =
    signals.length > 0
      ? `${signals.join(' and ')} breached in each of the last ${window}`
      : `no SLO breached in each of the last ${window} (5xx > ${options.maxErrorRatePct} %, non-5xx p99 > ${options.maxP99Ms} ms, >= ${options.minRequestsPerBin} requests and ${options.minLatencySamplesPerBin} latency samples/min)`;
  return { breached: signals.length > 0, signals, reason, bins };
}

/**
 * @param {{ apl: string, start: Date, end: Date, token: string, baseUrl?: string, fetchImpl?: typeof fetch }} options
 */
export async function queryAxiom({
  apl,
  start,
  end,
  token,
  baseUrl = 'https://api.axiom.co',
  fetchImpl = fetch,
}) {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/datasets/_apl?format=tabular`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ apl, startTime: start.toISOString(), endTime: end.toISOString() }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Axiom query failed: HTTP ${res.status}`);
  return parseTabular(await res.json());
}

/* ------------------------------------------------------------------ */
/*  Rollback plan                                                      */
/* ------------------------------------------------------------------ */

/** @param {any} deployment */
function triggeredBy(deployment) {
  return deployment?.annotations?.['workers/triggered_by'];
}

/**
 * A deployment made by a rollback: Cloudflare's own trigger annotation, or
 * the message every repository rollback path writes (`wrangler rollback`
 * and `versions deploy` set no trigger themselves).
 *
 * @param {any} deployment
 */
export function isRollbackDeployment(deployment) {
  const message = deployment?.annotations?.['workers/message'];
  return (
    triggeredBy(deployment) === 'rollback' ||
    (typeof message === 'string' && /rollback/i.test(message))
  );
}

/** @param {any} deployment @returns {any[]} the versions taking traffic */
function servingVersions(deployment) {
  const versions = Array.isArray(deployment?.versions) ? deployment.versions : [];
  return versions.filter((v) => Number(v?.percentage) > 0);
}

/** @param {any} deployment @returns {string | null} the version serving 100 %, if any */
function fullVersion(deployment) {
  const versions = servingVersions(deployment);
  if (versions.length !== 1 || Number(versions[0]?.percentage) !== 100) return null;
  const id = versions[0]?.version_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * The version one Worker would roll back to, from its `wrangler deployments
 * list --json` output (latest ten deployments).
 *
 * @param {any[]} deployments
 * @param {{ now: Date, windowMinutes: number, maxDeploymentAgeHours: number }} options
 * @returns {{ ok: true, current: { deploymentId: string, versionId: string, createdOn: string }, target: { deploymentId: string, versionId: string, createdOn: string } } | { ok: false, rolledBack: boolean, reason: string }}
 */
export function planWorker(deployments, options) {
  const refuse = (reason, rolledBack = false) => ({ ok: false, rolledBack, reason });
  if (!Array.isArray(deployments) || deployments.length === 0) return refuse('no deployments');
  const sorted = [...deployments].sort((a, b) =>
    String(a?.created_on).localeCompare(String(b?.created_on)),
  );
  const current = sorted.at(-1);
  const currentVersion = fullVersion(current);
  if (currentVersion === null) {
    return refuse('the live deployment splits traffic (a canary is in progress)');
  }
  if (isRollbackDeployment(current)) {
    return refuse('the live deployment is already a rollback', true);
  }
  if (triggeredBy(current) === 'secret') {
    return refuse('the live deployment is a secret change, not a release');
  }
  const ageMs = options.now.getTime() - Date.parse(String(current.created_on));
  if (!Number.isFinite(ageMs)) return refuse('the live deployment has no creation time');
  if (ageMs < options.windowMinutes * MINUTE_MS) {
    return refuse(
      `the live deployment is younger than the ${options.windowMinutes} min evaluation window, so the breach may predate it`,
    );
  }
  if (ageMs > options.maxDeploymentAgeHours * 60 * MINUTE_MS) {
    return refuse(`the live deployment is older than ${options.maxDeploymentAgeHours} h`);
  }

  let targetIndex = -1;
  for (let i = sorted.length - 2; i >= 0; i--) {
    const version = fullVersion(sorted[i]);
    if (version !== null && version !== currentVersion) {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex === -1) {
    return refuse('no earlier deployment served another version at 100 % (no previous version)');
  }
  const target = sorted[targetIndex];
  const targetVersion = fullVersion(target);
  for (const deployment of sorted.slice(targetIndex + 1)) {
    if (triggeredBy(deployment) === 'secret') {
      return refuse('secrets changed since the previous version');
    }
    if (isRollbackDeployment(deployment)) {
      return refuse('a rollback happened since the previous version');
    }
    const ids = servingVersions(deployment).map((v) => v?.version_id);
    if (ids.some((id) => id !== currentVersion && id !== targetVersion)) {
      return refuse(
        'another version (secret change or hotfix) was deployed between the previous version and the live one',
      );
    }
  }
  const describe = (deployment, versionId) => ({
    deploymentId: String(deployment.id),
    versionId,
    createdOn: String(deployment.created_on),
  });
  return {
    ok: true,
    current: describe(current, currentVersion),
    target: describe(target, targetVersion),
  };
}

/**
 * Release (git SHA) a version runs: its `VERSION` var, which every deploy
 * path sets to the 7-char commit SHA.
 *
 * @param {any} version `wrangler versions view --json` output
 * @returns {string | null}
 */
export function releaseOf(version) {
  const bindings = version?.resources?.bindings;
  const binding = Array.isArray(bindings)
    ? bindings.find((b) => b?.name === 'VERSION' && b?.type === 'plain_text')
    : undefined;
  const text = typeof binding?.text === 'string' ? binding.text.trim().toLowerCase() : '';
  return RELEASE_RE.test(text) ? text : null;
}

/**
 * Forward migrations between the two releases that carry the contract
 * marker: rolling back across one would run old code against a schema it
 * no longer matches.
 *
 * @param {{ path: string, content: string }[]} files
 * @returns {string[]}
 */
export function findContractMigrations(files) {
  return files
    .filter(({ path: file }) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .filter(({ content }) => CONTRACT_MARKER.test(content))
    .map(({ path: file }) => file)
    .sort();
}

/**
 * Fleet-wide decision: roll every Worker back, or none.
 *
 * @param {{
 *   workers: { name: string, config: string, deployments: any[], currentRelease?: string | null, targetRelease?: string | null }[],
 *   history?: { ok: boolean, reason?: string, contractMigrations?: string[] },
 *   now: Date,
 *   windowMinutes: number,
 *   cooldownMinutes: number,
 *   maxDeploymentAgeHours: number,
 * }} input
 * @returns {{ action: 'rollback' | 'noop' | 'refuse', reasons: string[], workers: object[], releases: { current: string | null, target: string | null } }}
 */
export function decideFleet(input) {
  const { now } = input;
  const plans = input.workers.map((worker) => ({
    ...worker,
    plan: planWorker(worker.deployments, input),
  }));
  const reasons = [];
  const recentRollback = plans.some((worker) =>
    (worker.deployments ?? []).some(
      (d) =>
        isRollbackDeployment(d) &&
        now.getTime() - Date.parse(String(d?.created_on)) < input.cooldownMinutes * MINUTE_MS,
    ),
  );
  const summary = plans.map(({ name, config, plan, currentRelease, targetRelease }) => ({
    name,
    config,
    ...(plan.ok
      ? {
          currentVersionId: plan.current.versionId,
          currentDeploymentId: plan.current.deploymentId,
          currentCreatedOn: plan.current.createdOn,
          targetVersionId: plan.target.versionId,
          targetCreatedOn: plan.target.createdOn,
          currentRelease: currentRelease ?? null,
          targetRelease: targetRelease ?? null,
        }
      : { refused: plan.reason }),
  }));
  const result = (action, releases = { current: null, target: null }) => ({
    action,
    reasons,
    workers: summary,
    releases,
  });

  if (plans.every(({ plan }) => !plan.ok && plan.rolledBack)) {
    if (recentRollback) {
      reasons.push(
        `every production Worker was already rolled back within ${input.cooldownMinutes} min`,
      );
      return result('noop');
    }
    reasons.push(
      'every production Worker already serves a rollback; rolling back again would redeploy the bad version',
    );
    return result('refuse');
  }
  for (const { name, plan } of plans) {
    if (!plan.ok) reasons.push(`${name}: ${plan.reason}`);
  }
  if (recentRollback) {
    reasons.push(`a rollback already happened within the ${input.cooldownMinutes} min cool-down`);
  }
  if (reasons.length > 0) return result('refuse');

  const currents = new Set(plans.map((w) => w.currentRelease ?? null));
  const targets = new Set(plans.map((w) => w.targetRelease ?? null));
  if (currents.has(null) || targets.has(null)) {
    reasons.push('the release SHA of a live or previous version cannot be resolved');
  } else if (currents.size !== 1 || targets.size !== 1) {
    reasons.push(
      `the Workers do not share one release (live: ${[...currents].join(', ')}; previous: ${[...targets].join(', ')})`,
    );
  }
  if (reasons.length > 0) return result('refuse');
  const releases = { current: [...currents][0], target: [...targets][0] };
  if (releases.current === releases.target) {
    reasons.push(`the previous version runs the same release ${releases.current}`);
    return result('refuse', releases);
  }

  const history = input.history ?? { ok: false, reason: 'git history not checked' };
  if (!history.ok) {
    reasons.push(history.reason ?? 'git history between the releases cannot be checked');
  } else if ((history.contractMigrations ?? []).length > 0) {
    reasons.push(
      `contract migration(s) landed between ${releases.target} and ${releases.current}: ${history.contractMigrations.join(', ')}`,
    );
  }
  if (reasons.length > 0) return result('refuse', releases);
  reasons.push(`roll every production Worker back from ${releases.current} to ${releases.target}`);
  return result('rollback', releases);
}

/**
 * Before touching anything, every Worker must still serve the planned live
 * version (or already the target, when a previous run got that far).
 *
 * @param {{ name: string, currentVersionId: string, targetVersionId: string }[]} planned
 * @param {Record<string, any[]>} liveDeployments by Worker name
 * @returns {{ ok: boolean, pending: string[], done: string[], reason?: string }}
 */
export function checkLiveAgainstPlan(planned, liveDeployments) {
  const pending = [];
  const done = [];
  for (const worker of planned) {
    const sorted = [...(liveDeployments[worker.name] ?? [])].sort((a, b) =>
      String(a?.created_on).localeCompare(String(b?.created_on)),
    );
    const live = fullVersion(sorted.at(-1));
    if (live === worker.targetVersionId) done.push(worker.name);
    else if (live === worker.currentVersionId) pending.push(worker.name);
    else {
      return {
        ok: false,
        pending,
        done,
        reason: `${worker.name} serves ${live ?? 'a split deployment'}, neither the planned live version nor the target`,
      };
    }
  }
  return { ok: true, pending, done };
}

/**
 * Redeploy each Worker's target in order. A Worker already on its target
 * is skipped. When the gateway fails, the sub-workers are left alone: a new
 * gateway in front of older sub-workers is the version skew the ordering
 * exists to avoid. A sub-worker failure does not stop the others, since the
 * gateway already serves the previous release.
 *
 * @param {{ name: string, currentVersionId: string, targetVersionId: string }[]} planned in rollback order
 * @param {string[]} done Workers already on their target
 * @param {(worker: object) => void} deploy throws on failure
 * @returns {{ failures: string[], skipped: string[], lines: string[] }}
 */
export function runRollbackSequence(planned, done, deploy) {
  const failures = [];
  const skipped = [];
  const lines = [];
  for (const worker of planned) {
    if (done.includes(worker.name)) {
      lines.push(`- ${worker.name}: already on ${worker.targetVersionId}`);
      continue;
    }
    if (failures.includes('gateway')) {
      skipped.push(worker.name);
      lines.push(`- ${worker.name}: not attempted (gateway rollback failed)`);
      continue;
    }
    try {
      deploy(worker);
      lines.push(`- ${worker.name}: ${worker.currentVersionId} → ${worker.targetVersionId}`);
    } catch (err) {
      failures.push(worker.name);
      lines.push(`- ${worker.name}: FAILED (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { failures, skipped, lines };
}

/* ------------------------------------------------------------------ */
/*  CLI                                                                */
/* ------------------------------------------------------------------ */

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[arg.slice(2)] = next;
      i++;
    } else {
      flags[arg.slice(2)] = true;
    }
  }
  return flags;
}

function output(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
}

function report(flags, markdown) {
  console.log(markdown);
  for (const file of [flags.report, process.env.GITHUB_STEP_SUMMARY]) {
    if (typeof file === 'string' && file.length > 0) appendFileSync(file, `${markdown}\n\n`);
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function wrangler(args, { capture = true } = {}) {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...args], {
    cwd: API_DIR,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `wrangler ${args.slice(0, 2).join(' ')} failed: ${result.stderr?.trim() || `exit ${result.status}`}`,
    );
  }
  return result.stdout ?? '';
}

function wranglerJson(args) {
  const stdout = wrangler([...args, '--json']);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`wrangler ${args.slice(0, 2).join(' ')} returned invalid JSON`);
  }
}

function listDeployments(config) {
  const deployments = wranglerJson(['deployments', 'list', '-c', config, '--env', 'production']);
  if (!Array.isArray(deployments)) throw new Error(`${config}: unexpected deployments output`);
  return deployments;
}

function viewVersion(config, versionId) {
  return wranglerJson(['versions', 'view', versionId, '-c', config, '--env', 'production']);
}

function git(args) {
  return run('git', args, ROOT);
}

/** @returns {{ ok: boolean, reason?: string, contractMigrations?: string[] }} */
export function checkHistory(target, current) {
  const resolve = (sha) => {
    const { status, stdout } = git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
    return status === 0 ? stdout.trim() : null;
  };
  const from = resolve(target);
  const to = resolve(current);
  if (!from || !to) {
    return { ok: false, reason: `release ${!from ? target : current} is not in the git history` };
  }
  if (git(['merge-base', '--is-ancestor', from, to]).status !== 0) {
    return { ok: false, reason: `release ${target} is not an ancestor of ${current}` };
  }
  const diff = git([
    'diff',
    '--name-only',
    '--diff-filter=ACMR',
    from,
    to,
    '--',
    `${MIGRATIONS_DIR}/`,
  ]);
  if (diff.status !== 0) return { ok: false, reason: 'git diff of the migrations failed' };
  const files = [];
  for (const file of diff.stdout.split('\n').filter(Boolean)) {
    const show = git(['show', `${to}:${file}`]);
    if (show.status !== 0) return { ok: false, reason: `cannot read ${file} at ${current}` };
    files.push({ path: file, content: show.stdout });
  }
  return { ok: true, contractMigrations: findContractMigrations(files) };
}

async function commandCheck(flags) {
  const token = process.env.AXIOM_QUERY_TOKEN;
  const dataset = process.env.AXIOM_SPANS_DATASET;
  if (!token || !dataset) throw new Error('AXIOM_QUERY_TOKEN and AXIOM_SPANS_DATASET are required');
  const sampleRate = readOtelSampleRate(
    readFileSync(path.join(API_DIR, 'wrangler.toml'), 'utf8'),
    'production',
  );
  const { start, end } = evaluationWindow(new Date(), SLO_ROLLBACK.windowMinutes);
  const rows = await queryAxiom({
    apl: buildBreachQuery({ dataset, sampleRate }),
    start,
    end,
    token,
    baseUrl: process.env.AXIOM_URL || undefined,
  });
  const verdict = evaluateBreach(rows, { start, ...SLO_ROLLBACK });
  output({ breached: String(verdict.breached) });
  const table = verdict.bins
    .map(
      (bin) =>
        `| ${bin.time} | ${Number.isFinite(bin.requests) ? Math.round(bin.requests) : '–'} | ${Number.isFinite(bin.ratePct) ? bin.ratePct.toFixed(2) : '–'} | ${Number.isFinite(bin.p99Ms) ? Math.round(bin.p99Ms) : '–'} |`,
    )
    .join('\n');
  report(
    flags,
    [
      `### SLO re-check (Axiom, ${start.toISOString()} → ${end.toISOString()})`,
      '',
      `**${verdict.breached ? 'BREACH' : 'No sustained breach'}**: ${verdict.reason}.`,
      '',
      '| minute | est. requests | 5xx % | p99 ms |',
      '| --- | --- | --- | --- |',
      table,
    ].join('\n'),
  );
}

function commandPlan(flags) {
  if (typeof flags.out !== 'string') throw new Error('--out is required');
  const now = new Date();
  const workers = PRODUCTION_WORKERS.map((worker) => {
    const deployments = listDeployments(worker.config);
    const plan = planWorker(deployments, { now, ...SLO_ROLLBACK });
    if (!plan.ok) return { ...worker, deployments };
    return {
      ...worker,
      deployments,
      currentRelease: releaseOf(viewVersion(worker.config, plan.current.versionId)),
      targetRelease: releaseOf(viewVersion(worker.config, plan.target.versionId)),
    };
  });
  const preliminary = decideFleet({ workers, now, ...SLO_ROLLBACK });
  const { current, target } = preliminary.releases;
  const decision =
    current && target && current !== target
      ? decideFleet({ workers, history: checkHistory(target, current), now, ...SLO_ROLLBACK })
      : preliminary;
  writeFileSync(flags.out, `${JSON.stringify(decision, null, 2)}\n`);
  output({ action: decision.action });
  const rows = decision.workers
    .map((w) =>
      w.refused
        ? `| ${w.name} | – | – | refused: ${w.refused} |`
        : `| ${w.name} | ${w.currentVersionId} (${w.currentRelease ?? '?'}) | ${w.targetVersionId} (${w.targetRelease ?? '?'}) | ok |`,
    )
    .join('\n');
  report(
    flags,
    [
      `### Rollback plan: \`${decision.action}\``,
      '',
      ...decision.reasons.map((reason) => `- ${reason}`),
      '',
      '| Worker | live version | previous version | guard |',
      '| --- | --- | --- | --- |',
      rows,
    ].join('\n'),
  );
}

function commandRollback(flags) {
  if (typeof flags.plan !== 'string') throw new Error('--plan is required');
  const plan = JSON.parse(readFileSync(flags.plan, 'utf8'));
  if (plan?.action !== 'rollback') throw new Error(`plan action is ${plan?.action}, not rollback`);
  const planned = PRODUCTION_WORKERS.map((worker) => {
    const entry = plan.workers.find((w) => w.name === worker.name);
    if (!entry?.currentVersionId || !entry?.targetVersionId) {
      throw new Error(`plan has no versions for ${worker.name}`);
    }
    return { ...worker, ...entry, config: worker.config };
  });

  const live = Object.fromEntries(planned.map((w) => [w.name, listDeployments(w.config)]));
  const state = checkLiveAgainstPlan(planned, live);
  if (!state.ok) throw new Error(`live deployments changed since the plan: ${state.reason}`);

  const reason = typeof flags.reason === 'string' ? flags.reason : 'slo breach';
  const message = `slo-rollback ${plan.releases.current} -> ${plan.releases.target}: ${reason}`
    .replace(/[^\w .:>#/-]/g, '')
    .slice(0, 120);
  const { failures, lines } = runRollbackSequence(planned, state.done, (worker) =>
    wrangler(
      [
        'versions',
        'deploy',
        '-c',
        worker.config,
        '--env',
        'production',
        '--version-id',
        worker.targetVersionId,
        '--percentage',
        '100',
        '--message',
        message,
        '-y',
      ],
      { capture: false },
    ),
  );

  const after = Object.fromEntries(planned.map((w) => [w.name, listDeployments(w.config)]));
  const verified = checkLiveAgainstPlan(planned, after);
  const notOnTarget = planned.map((w) => w.name).filter((name) => !verified.done.includes(name));
  report(
    flags,
    [
      `### Rollback ${failures.length === 0 && notOnTarget.length === 0 ? 'done' : 'INCOMPLETE'}`,
      '',
      ...lines,
      ...(notOnTarget.length > 0
        ? ['', `Not on the previous version: ${notOnTarget.join(', ')}`]
        : []),
    ].join('\n'),
  );
  if (failures.length > 0 || notOnTarget.length > 0) {
    throw new Error(
      `rollback incomplete (${[...new Set([...failures, ...notOnTarget])].join(', ')}): the fleet may run mixed versions`,
    );
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (command) {
    case 'check':
      await commandCheck(flags);
      break;
    case 'plan':
      commandPlan(flags);
      break;
    case 'rollback':
      commandRollback(flags);
      break;
    default:
      console.error('Usage: node scripts/slo-rollback.mjs check|plan|rollback (see file header)');
      process.exit(2);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
