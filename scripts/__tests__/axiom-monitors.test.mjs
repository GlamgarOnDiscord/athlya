import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (file) =>
  readFileSync(new URL(`../../infra/terraform/${file}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

const tf = read('axiom-monitors.tf');
const versions = read('versions.tf');

/** Production-critical SLO alerts that must exist as code (#415). */
const REQUIRED_MONITORS = [
  'api_5xx_rate',
  'auth_login_p95',
  'reservations_book_p99',
  'queue_lag',
  'outbox_backlog',
  'dlq_depth',
];

describe('axiom-monitors.tf', () => {
  it('pins the axiomhq/axiom provider', () => {
    assert.match(versions, /source\s*=\s*"axiomhq\/axiom"\s*\n\s*version\s*=\s*"~> \d+\.\d+"/);
  });

  for (const key of REQUIRED_MONITORS) {
    it(`defines the ${key} SLO monitor`, () => {
      assert.match(tf, new RegExp(`\\n    ${key} = \\{[\\s\\S]*?apl_query`));
    });
  }

  it('creates every monitor from the SLO map with notifiers', () => {
    const resource = /resource "axiom_monitor" "slo" \{([\s\S]*?)\n\}/.exec(tf);
    assert.ok(resource, 'axiom_monitor.slo missing');
    assert.match(resource[1], /for_each\s*=\s*local\.axiom_slo_monitors/);
  });

  it('declares fail-closed variables (no defaults, validated)', () => {
    const variables = [...tf.matchAll(/variable "(axiom_[a-z_]+)" \{([\s\S]*?)\n\}/g)];
    assert.deepEqual(variables.map(([, name]) => name).sort(), [
      'axiom_api_token',
      'axiom_logs_dataset',
      'axiom_notifier_ids',
      'axiom_page_notifier_ids',
      'axiom_spans_dataset',
    ]);
    for (const [, name, body] of variables) {
      assert.doesNotMatch(body, /\bdefault\s*=/, `${name} must not have a default`);
      assert.match(body, /validation \{/, `${name} must be validated`);
    }
  });

  it('scales the 5xx ratio by the OTEL_SAMPLE_RATE wrangler.toml deploys', () => {
    const wrangler = readFileSync(
      new URL('../../packages/api/wrangler.toml', import.meta.url),
      'utf8',
    );
    for (const env of ['staging', 'production']) {
      const vars = wrangler.split(`[env.${env}.vars]`)[1]?.split(/\n\[/)[0] ?? '';
      const deployed = /OTEL_SAMPLE_RATE\s*=\s*"([\d.]+)"/.exec(vars)?.[1];
      const local = new RegExp(`\\b${env}\\s*=\\s*([\\d.]+)`).exec(tf)?.[1];
      assert.ok(deployed, `OTEL_SAMPLE_RATE missing for ${env}`);
      assert.equal(Number(local), Number(deployed), env);
    }
    assert.match(tf, /todouble\(total - errors\) \/ \$\{local\.otel_sample_rate\}/);
    // /health* spans are sampled at 1 %, not at OTEL_SAMPLE_RATE.
    assert.match(tf, /where not\(name contains " \/health"\)\n\s*\| summarize total = count\(\)/);
  });

  it('pages on-call only through the page flag', () => {
    assert.match(
      tf,
      /notifier_ids\s*=\s*each\.value\.page \? concat\(var\.axiom_notifier_ids, var\.axiom_page_notifier_ids\) : var\.axiom_notifier_ids/,
    );
  });

  it('queries only signals the runtime emits', () => {
    assert.doesNotMatch(tf, /drain\.batch|queue\.lag_ms|drain\.dlq\.stats|\['data'\]/);
  });
});
