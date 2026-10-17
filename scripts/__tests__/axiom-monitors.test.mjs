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
    assert.match(resource[1], /notifier_ids\s*=\s*var\.axiom_notifier_ids/);
  });

  it('declares fail-closed variables (no defaults, validated)', () => {
    const variables = [...tf.matchAll(/variable "(axiom_[a-z_]+)" \{([\s\S]*?)\n\}/g)];
    assert.deepEqual(variables.map(([, name]) => name).sort(), [
      'axiom_api_token',
      'axiom_logs_dataset',
      'axiom_notifier_ids',
      'axiom_spans_dataset',
    ]);
    for (const [, name, body] of variables) {
      assert.doesNotMatch(body, /\bdefault\s*=/, `${name} must not have a default`);
      assert.match(body, /validation \{/, `${name} must be validated`);
    }
  });

  it('queries only signals the runtime emits', () => {
    assert.doesNotMatch(tf, /drain\.batch|queue\.lag_ms|drain\.dlq\.stats|\['data'\]/);
  });
});
