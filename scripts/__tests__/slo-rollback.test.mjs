import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  PRODUCTION_WORKERS,
  SLO_ROLLBACK,
  buildBreachQuery,
  checkLiveAgainstPlan,
  decideFleet,
  evaluateBreach,
  evaluationWindow,
  findContractMigrations,
  isRollbackDeployment,
  parseTabular,
  planWorker,
  queryAxiom,
  readOtelSampleRate,
  releaseOf,
  runRollbackSequence,
} from '../slo-rollback.mjs';

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

const NOW = new Date('2026-10-18T12:00:30Z');
const OPTIONS = { now: NOW, ...SLO_ROLLBACK };
const minutesAgo = (minutes) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const deployment = (id, minutes, versions, annotations = {}) => ({
  id,
  created_on: minutesAgo(minutes),
  annotations,
  versions: Object.entries(versions).map(([version_id, percentage]) => ({
    version_id,
    percentage,
  })),
});

/** A canary rollout of `new` over `old`, finished `age` minutes ago. */
const canaryHistory = (age = 30) => [
  deployment('d0', age + 600, { old: 100 }),
  deployment('d1', age + 25, { new: 1, old: 99 }),
  deployment('d2', age + 12, { new: 10, old: 90 }),
  deployment('d3', age, { new: 100 }),
];

describe('evaluateBreach', () => {
  const { start } = evaluationWindow(NOW, SLO_ROLLBACK.windowMinutes);
  const rows = (fn) =>
    Array.from({ length: SLO_ROLLBACK.windowMinutes }, (_, i) => ({
      _time: new Date(start.getTime() + i * 60_000).toISOString(),
      requests: 100,
      rate_pct: 0.1,
      ok_samples: 90,
      p99_ms: 300,
      ...fn(i),
    }));
  const evaluate = (input) => evaluateBreach(input, { start, ...SLO_ROLLBACK });

  it('ends the window on the last whole minute before the current one', () => {
    const window = evaluationWindow(NOW, 10);
    assert.equal(window.end.toISOString(), '2026-10-18T11:59:00.000Z');
    assert.equal(window.start.toISOString(), '2026-10-18T11:49:00.000Z');
  });

  it('breaches when every bin is above the error-rate threshold', () => {
    const verdict = evaluate(rows(() => ({ rate_pct: 5 })));
    assert.equal(verdict.breached, true);
    assert.deepEqual(verdict.signals, ['error_rate']);
  });

  it('breaches on latency alone', () => {
    const verdict = evaluate(rows(() => ({ p99_ms: 2500 })));
    assert.deepEqual(verdict.signals, ['latency_p99']);
  });

  it('does not breach on latency at the threshold itself', () => {
    assert.equal(evaluate(rows(() => ({ p99_ms: SLO_ROLLBACK.maxP99Ms }))).breached, false);
    assert.equal(evaluate(rows(() => ({ p99_ms: SLO_ROLLBACK.maxP99Ms + 1 }))).breached, true);
  });

  it('does not judge latency on too few sampled non-5xx spans', () => {
    const few = SLO_ROLLBACK.minLatencySamplesPerBin - 1;
    assert.equal(evaluate(rows(() => ({ p99_ms: 5000, ok_samples: few }))).breached, false);
    assert.equal(evaluate(rows(() => ({ p99_ms: 5000, ok_samples: null }))).breached, false);
  });

  it('does not breach when one bin recovers', () => {
    assert.equal(evaluate(rows((i) => ({ rate_pct: i === 4 ? 1 : 5 }))).breached, false);
  });

  it('does not breach at the threshold itself', () => {
    assert.equal(
      evaluate(rows(() => ({ rate_pct: SLO_ROLLBACK.maxErrorRatePct }))).breached,
      false,
    );
  });

  it('does not breach when a bin is missing', () => {
    assert.equal(evaluate(rows(() => ({ rate_pct: 5 })).slice(1)).breached, false);
  });

  it('does not breach on low traffic', () => {
    assert.equal(
      evaluate(rows((i) => ({ rate_pct: 50, requests: i === 0 ? 3 : 100 }))).breached,
      false,
    );
  });

  it('does not breach on non-numeric values', () => {
    assert.equal(evaluate(rows(() => ({ rate_pct: null }))).breached, false);
  });

  it('does not mix signals across bins', () => {
    const verdict = evaluate(rows((i) => (i % 2 ? { rate_pct: 5 } : { p99_ms: 5000 })));
    assert.equal(verdict.breached, false);
  });
});

describe('Axiom query and parsing', () => {
  it('reads the production sample rate from wrangler.toml', () => {
    assert.equal(readOtelSampleRate(read('packages/api/wrangler.toml'), 'production'), 0.1);
    assert.ok(Number.isNaN(readOtelSampleRate('[env.production.vars]\nX = "1"\n', 'production')));
    assert.ok(
      Number.isNaN(
        readOtelSampleRate('[env.production.vars]\nOTEL_SAMPLE_RATE = "0"\n', 'production'),
      ),
    );
  });

  it('builds a per-minute query with the 5xx monitor filter and sampling', () => {
    const apl = buildBreachQuery({ dataset: 'athlya-prod', sampleRate: 0.1 });
    assert.match(apl, /^\['athlya-prod'\]/);
    assert.match(apl, /where not\(name contains " \/health"\)/);
    assert.match(apl, /by bin\(_time, 1m\)/);
    assert.match(apl, /todouble\(total - errors\) \/ 0\.1/);
  });

  it('takes the p99 over the uniformly sampled non-5xx spans only', () => {
    const apl = buildBreachQuery({ dataset: 'athlya-prod', sampleRate: 0.1 });
    assert.match(apl, /p99_ms = percentileif\(duration, 99, \['status\.code'\] != "ERROR"\)/);
    assert.match(apl, /ok_samples = countif\(\['status\.code'\] != "ERROR"\)/);
    assert.doesNotMatch(apl, /percentile\(duration/);
    assert.match(apl, /project _time, requests, rate_pct, ok_samples, p99_ms/);
  });

  it('rejects an injected dataset name or a bad rate', () => {
    assert.throws(() => buildBreachQuery({ dataset: "x'] | union ['y", sampleRate: 0.1 }));
    assert.throws(() => buildBreachQuery({ dataset: 'x', sampleRate: Number.NaN }));
  });

  it('parses column-major tabular results', () => {
    const rows = parseTabular({
      tables: [
        {
          fields: [{ name: '_time' }, { name: 'rate_pct' }],
          columns: [
            ['2026-10-18T11:49:00Z', '2026-10-18T11:50:00Z'],
            [3, 4],
          ],
        },
      ],
    });
    assert.deepEqual(rows, [
      { _time: '2026-10-18T11:49:00Z', rate_pct: 3 },
      { _time: '2026-10-18T11:50:00Z', rate_pct: 4 },
    ]);
  });

  it('fails closed on an unexpected shape', () => {
    assert.throws(() => parseTabular({}));
    assert.throws(() => parseTabular({ tables: [{ fields: [{ name: 'a' }], columns: [] }] }));
    assert.throws(() =>
      parseTabular({ tables: [{ fields: [{ name: 'a' }, { name: 'b' }], columns: [[1], []] }] }),
    );
  });

  it('posts the APL with the token and throws on HTTP errors', async () => {
    let request;
    const ok = async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ tables: [{ fields: [], columns: [] }] }));
    };
    const window = evaluationWindow(NOW, 10);
    assert.deepEqual(await queryAxiom({ apl: 'q', ...window, token: 't', fetchImpl: ok }), []);
    assert.equal(request.url, 'https://api.axiom.co/v1/datasets/_apl?format=tabular');
    assert.equal(request.init.headers.authorization, 'Bearer t');
    assert.equal(JSON.parse(request.init.body).startTime, '2026-10-18T11:49:00.000Z');
    const denied = async () => new Response('no', { status: 403 });
    await assert.rejects(queryAxiom({ apl: 'q', ...window, token: 't', fetchImpl: denied }));
  });
});

describe('planWorker', () => {
  it('targets the previous 100 % version after a canary', () => {
    const plan = planWorker(canaryHistory(), OPTIONS);
    assert.equal(plan.ok, true);
    assert.equal(plan.current.versionId, 'new');
    assert.equal(plan.target.versionId, 'old');
  });

  it('targets the previous version after a direct deploy', () => {
    const plan = planWorker(
      [
        deployment('a', 900, { v1: 100 }),
        deployment('b', 600, { v2: 100 }),
        deployment('c', 60, { v3: 100 }),
      ],
      OPTIONS,
    );
    assert.equal(plan.target.versionId, 'v2');
  });

  it('ignores 0 % entries', () => {
    const plan = planWorker(
      [deployment('a', 600, { old: 100 }), deployment('b', 30, { new: 100, old: 0 })],
      OPTIONS,
    );
    assert.equal(plan.ok, true);
  });

  it('refuses while a canary splits traffic', () => {
    const plan = planWorker(canaryHistory().slice(0, 3), OPTIONS);
    assert.match(plan.reason, /canary/);
  });

  it('refuses without a previous version', () => {
    assert.match(
      planWorker([deployment('a', 30, { v1: 100 })], OPTIONS).reason,
      /no previous version/,
    );
    assert.match(planWorker([], OPTIONS).reason, /no deployments/);
    assert.match(
      planWorker([deployment('a', 90, { v1: 100 }), deployment('b', 30, { v1: 100 })], OPTIONS)
        .reason,
      /no previous version/,
    );
  });

  it('refuses a release younger than the evaluation window', () => {
    assert.match(planWorker(canaryHistory(5), OPTIONS).reason, /younger/);
  });

  it('refuses a release older than the maximum age', () => {
    assert.match(planWorker(canaryHistory(25 * 60), OPTIONS).reason, /older/);
  });

  it('flags a live rollback (by trigger or message) as already rolled back', () => {
    for (const annotations of [
      { 'workers/triggered_by': 'rollback' },
      { 'workers/message': 'slo-rollback abc1234 -> def5678: run 1' },
      { 'workers/message': 'canary-deploy rollback (issue #129)' },
    ]) {
      const history = [...canaryHistory(), deployment('d4', 15, { old: 100 }, annotations)];
      const plan = planWorker(history, OPTIONS);
      assert.equal(plan.ok, false);
      assert.equal(plan.rolledBack, true);
    }
  });

  it('refuses when secrets changed since the previous version', () => {
    const history = [
      deployment('a', 600, { old: 100 }),
      deployment('b', 300, { rotated: 100 }, { 'workers/triggered_by': 'secret' }),
      deployment('c', 30, { new: 100 }),
    ];
    // The rotated version is itself the previous 100 % version; the secret
    // change is caught one step earlier when it sits between target and live.
    assert.equal(planWorker(history, OPTIONS).target.versionId, 'rotated');
    const between = [
      deployment('a', 600, { old: 100 }),
      deployment('b', 300, { new: 50, old: 50 }),
      deployment('c', 200, { new: 100 }, { 'workers/triggered_by': 'secret' }),
      deployment('d', 30, { new: 100 }),
    ];
    assert.match(planWorker(between, OPTIONS).reason, /secrets changed/);
    const live = [
      deployment('a', 600, { old: 100 }),
      deployment('b', 30, { new: 100 }, { 'workers/triggered_by': 'secret' }),
    ];
    assert.match(planWorker(live, OPTIONS).reason, /secret change/);
  });

  it('refuses when a third version was deployed in between', () => {
    const history = [
      deployment('a', 600, { old: 100 }),
      deployment('b', 300, { new: 10, hotfix: 90 }),
      deployment('c', 30, { new: 100 }),
    ];
    assert.match(planWorker(history, OPTIONS).reason, /another version/);
  });

  it('refuses when a rollback sits between the previous version and the live one', () => {
    const history = [
      deployment('a', 600, { old: 100 }),
      deployment('b', 300, { new: 10, old: 90 }, { 'workers/message': 'Rollback' }),
      deployment('c', 30, { new: 100 }),
    ];
    assert.match(planWorker(history, OPTIONS).reason, /rollback happened/);
  });
});

describe('releaseOf / isRollbackDeployment / findContractMigrations', () => {
  it('reads the VERSION plain-text binding', () => {
    const version = (text, type = 'plain_text') => ({
      resources: { bindings: [{ name: 'VERSION', type, text }] },
    });
    assert.equal(releaseOf(version('abc1234')), 'abc1234');
    assert.equal(releaseOf(version('ABC1234')), 'abc1234');
    assert.equal(releaseOf(version('dev')), null);
    assert.equal(releaseOf(version('abc1234', 'secret_text')), null);
    assert.equal(releaseOf({}), null);
  });

  it('only treats rollback deployments as rollbacks', () => {
    assert.equal(
      isRollbackDeployment({ annotations: { 'workers/message': 'production-canary-abc1234' } }),
      false,
    );
    assert.equal(isRollbackDeployment({}), false);
  });

  it('finds forward migrations carrying the contract marker', () => {
    const files = [
      {
        path: 'packages/db/migrations/0050_drop_col.sql',
        content: '-- athlya:contract\nALTER TABLE x DROP COLUMN y;\n',
      },
      { path: 'packages/db/migrations/0050_drop_col.down.sql', content: '-- athlya:contract\n' },
      {
        path: 'packages/db/migrations/0049_add_col.sql',
        content: '-- expand only\nALTER TABLE x ADD COLUMN z int;\n',
      },
      {
        path: 'packages/db/migrations/0048_note.sql',
        content: 'SELECT 1; -- athlya:contract later\n',
      },
    ];
    assert.deepEqual(findContractMigrations(files), ['packages/db/migrations/0050_drop_col.sql']);
  });
});

describe('decideFleet', () => {
  const fleet = (overrides = {}) =>
    PRODUCTION_WORKERS.map((worker) => ({
      ...worker,
      deployments: canaryHistory(),
      currentRelease: 'bbbbbbb',
      targetRelease: 'aaaaaaa',
      ...(overrides[worker.name] ?? {}),
    }));
  const decide = (workers, history = { ok: true, contractMigrations: [] }) =>
    decideFleet({ workers, history, ...OPTIONS });

  it('rolls back every Worker, gateway first', () => {
    const decision = decide(fleet());
    assert.equal(decision.action, 'rollback');
    assert.deepEqual(
      decision.workers.map((w) => w.name),
      ['gateway', 'billing', 'reservations', 'auth'],
    );
    assert.deepEqual(decision.releases, { current: 'bbbbbbb', target: 'aaaaaaa' });
    assert.ok(decision.workers.every((w) => w.targetVersionId === 'old'));
  });

  it('touches none when one Worker trips a guard', () => {
    const decision = decide(fleet({ auth: { deployments: [deployment('a', 30, { v1: 100 })] } }));
    assert.equal(decision.action, 'refuse');
    assert.match(decision.reasons.join('\n'), /auth: no earlier deployment/);
  });

  it('is a no-op when the fleet was just rolled back', () => {
    const rolledBack = [
      ...canaryHistory(),
      deployment('r', 15, { old: 100 }, { 'workers/message': 'slo-rollback x' }),
    ];
    const decision = decide(
      fleet(
        Object.fromEntries(PRODUCTION_WORKERS.map((w) => [w.name, { deployments: rolledBack }])),
      ),
    );
    assert.equal(decision.action, 'noop');
  });

  it('refuses a second rollback once the cool-down is over', () => {
    const rolledBack = [
      ...canaryHistory(200),
      deployment('r', 120, { old: 100 }, { 'workers/message': 'slo-rollback x' }),
    ];
    const decision = decide(
      fleet(
        Object.fromEntries(PRODUCTION_WORKERS.map((w) => [w.name, { deployments: rolledBack }])),
      ),
    );
    assert.equal(decision.action, 'refuse');
    assert.match(decision.reasons[0], /redeploy the bad version/);
  });

  it('refuses a partially rolled-back fleet', () => {
    const rolledBack = [
      ...canaryHistory(),
      deployment('r', 15, { old: 100 }, { 'workers/message': 'Rollback' }),
    ];
    assert.equal(decide(fleet({ gateway: { deployments: rolledBack } })).action, 'refuse');
  });

  it('refuses within the cool-down of an earlier rollback', () => {
    const history = [
      deployment('a', 600, { old: 100 }),
      deployment('r', 50, { old: 100 }, { 'workers/message': 'slo-rollback x' }),
      deployment('c', 30, { new: 100 }),
    ];
    const decision = decide(fleet({ billing: { deployments: history } }));
    assert.equal(decision.action, 'refuse');
    assert.match(decision.reasons.join('\n'), /cool-down/);
  });

  it('refuses unresolved or inconsistent releases', () => {
    assert.match(
      decide(fleet({ gateway: { currentRelease: null } })).reasons[0],
      /cannot be resolved/,
    );
    assert.match(decide(fleet({ auth: { targetRelease: 'ccccccc' } })).reasons[0], /one release/);
    const same = PRODUCTION_WORKERS.map((w) => ({
      ...w,
      deployments: canaryHistory(),
      currentRelease: 'aaaaaaa',
      targetRelease: 'aaaaaaa',
    }));
    assert.match(decide(same).reasons[0], /same release/);
  });

  it('refuses across a contract migration or an unchecked history', () => {
    const contract = decide(fleet(), {
      ok: true,
      contractMigrations: ['packages/db/migrations/0050_drop_col.sql'],
    });
    assert.equal(contract.action, 'refuse');
    assert.match(contract.reasons[0], /contract migration/);
    assert.equal(decideFleet({ workers: fleet(), ...OPTIONS }).action, 'refuse');
    assert.equal(decide(fleet(), { ok: false, reason: 'not an ancestor' }).action, 'refuse');
  });
});

describe('checkLiveAgainstPlan', () => {
  const planned = [
    { name: 'gateway', currentVersionId: 'new', targetVersionId: 'old' },
    { name: 'auth', currentVersionId: 'new2', targetVersionId: 'old2' },
  ];

  it('splits pending and already rolled-back Workers', () => {
    const state = checkLiveAgainstPlan(planned, {
      gateway: [deployment('a', 5, { old: 100 })],
      auth: [deployment('b', 30, { new2: 100 })],
    });
    assert.deepEqual(state, { ok: true, pending: ['auth'], done: ['gateway'] });
  });

  it('aborts when a Worker moved to another version', () => {
    const state = checkLiveAgainstPlan(planned, {
      gateway: [deployment('a', 5, { hotfix: 100 })],
      auth: [deployment('b', 30, { new2: 100 })],
    });
    assert.equal(state.ok, false);
  });
});

describe('runRollbackSequence', () => {
  const planned = PRODUCTION_WORKERS.map((w) => ({
    ...w,
    currentVersionId: `${w.name}-new`,
    targetVersionId: `${w.name}-old`,
  }));
  const deployer = (failing = []) => {
    const calls = [];
    const deploy = (worker) => {
      calls.push(worker.name);
      if (failing.includes(worker.name)) throw new Error('API 10220');
    };
    return { calls, deploy };
  };

  it('rolls back in order, gateway first', () => {
    const { calls, deploy } = deployer();
    const result = runRollbackSequence(planned, [], deploy);
    assert.deepEqual(calls, ['gateway', 'billing', 'reservations', 'auth']);
    assert.deepEqual(result.failures, []);
  });

  it('touches no sub-worker when the gateway rollback fails', () => {
    const { calls, deploy } = deployer(['gateway']);
    const result = runRollbackSequence(planned, [], deploy);
    assert.deepEqual(calls, ['gateway']);
    assert.deepEqual(result.failures, ['gateway']);
    assert.deepEqual(result.skipped, ['billing', 'reservations', 'auth']);
  });

  it('keeps going after a sub-worker failure and skips Workers already done', () => {
    const { calls, deploy } = deployer(['billing']);
    const result = runRollbackSequence(planned, ['gateway'], deploy);
    assert.deepEqual(calls, ['billing', 'reservations', 'auth']);
    assert.deepEqual(result.failures, ['billing']);
    assert.deepEqual(result.skipped, []);
  });
});

describe('workflow and Terraform wiring', () => {
  const workflow = read('.github/workflows/slo-rollback.yml');
  const tf = read('infra/terraform/slo-auto-rollback.tf');

  it('lists every production Worker config', () => {
    assert.deepEqual(PRODUCTION_WORKERS.map((w) => w.config).sort(), [
      'wrangler.auth.toml',
      'wrangler.billing.toml',
      'wrangler.reservations.toml',
      'wrangler.toml',
    ]);
  });

  it('keeps the Axiom monitors on the script thresholds', () => {
    assert.match(tf, new RegExp(`threshold\\s+= ${SLO_ROLLBACK.maxErrorRatePct}\\n`));
    assert.match(tf, new RegExp(`threshold\\s+= ${SLO_ROLLBACK.maxP99Ms}\\n`));
    assert.match(tf, new RegExp(`trigger_from_n_runs = ${SLO_ROLLBACK.windowMinutes}\\n`));
    assert.match(tf, new RegExp(`where requests >= ${SLO_ROLLBACK.minRequestsPerBin}\\n`));
    assert.match(
      tf,
      new RegExp(`where ok_samples >= ${SLO_ROLLBACK.minLatencySamplesPerBin}\\\\n`),
    );
    assert.match(tf, /percentileif\(duration, 99, \['status\.code'\] != "ERROR"\)/);
  });

  it('serializes every production-mutating workflow on one lock', () => {
    const lock = /group: deploy-api-production-canary\n\s+cancel-in-progress: false/;
    for (const file of ['slo-rollback.yml', 'canary.yml', 'rollback.yml']) {
      assert.match(read(`.github/workflows/${file}`), lock, file);
    }
    assert.match(
      read('.github/workflows/deploy-production.yml'),
      /group: \$\{\{ startsWith\(inputs\.phase, 'staging-'\) && format\('deploy-api-\{0\}', inputs\.phase\) \|\| 'deploy-api-production-canary' \}\}/,
    );
  });

  it('alerts when the queued rollback is cancelled by the lock', () => {
    assert.match(
      workflow,
      /cancelled-alert:\n[\s\S]*?needs: slo-rollback\n\s+if: always\(\) && needs\.slo-rollback\.result == 'cancelled'/,
    );
    assert.doesNotMatch(workflow.split('jobs:')[0], /concurrency:/);
    const alert = workflow.split('cancelled-alert:')[1];
    assert.match(
      alert,
      /--jq \.html_url \\\n\s+\|\| echo "::warning::GitHub issue creation failed"/,
    );
    assert.match(
      alert,
      /creation failed"\n\s+if \[ -n "\$\{SLACK_WEBHOOK_URL:-\}" \]; then\n[^\n]*\n\s+\| curl [^\n]*"\$\{SLACK_WEBHOOK_URL\}"[^\n]*\n[^\n]*\n\s+fi\n\s+exit 1\n?$/,
    );
  });

  it('labels dry runs and never pages on them', () => {
    assert.match(workflow, /SLO auto-rollback DRY RUN/);
    assert.match(
      workflow,
      /name: Notify Slack and PagerDuty\n\s+if: >-\n\s+always\(\) && steps\.gate\.outputs\.enabled == 'true' && env\.DRY_RUN != 'true'/,
    );
  });

  it('keeps the Axiom webhook off by default and production-only', () => {
    assert.match(tf, /variable "slo_auto_rollback_enabled" \{[\s\S]*?default\s+= false/);
    assert.match(tf, /var\.slo_auto_rollback_enabled && var\.environment == "production"/);
    assert.match(tf, /variable "slo_auto_rollback_github_token" \{[\s\S]*?sensitive\s+= true/);
  });

  it('is gated by the kill switch, master and the shared deploy lock', () => {
    assert.match(workflow, /if \[ "\$\{AUTO_ROLLBACK_ENABLED\}" != 'true' \]/);
    assert.match(workflow, /if: github\.ref == 'refs\/heads\/master'/);
    assert.match(workflow, /group: deploy-api-production-canary\n\s+cancel-in-progress: false/);
    assert.doesNotMatch(workflow, /pull_request_target/);
  });

  it('pins every action by SHA', () => {
    for (const [, ref] of workflow.matchAll(/uses: [^@\s]+@(\S+)/g)) {
      assert.match(ref, /^[0-9a-f]{40}$/);
    }
  });
});
