import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const tf = readFileSync(new URL('../../infra/terraform/sentry-alerts.tf', import.meta.url), 'utf8');
const code = tf
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

/**
 * The Worker's Sentry client (packages/api/src/sentry.ts) only sends error
 * events, without user context (issue #415). Alerts must query that.
 */
describe('sentry-alerts.tf signal contract', () => {
  const alerts = [...code.matchAll(/resource "sentry_metric_alert" "([^"]+)" \{([\s\S]*?)\n\}/g)];

  it('declares at least one alert', () => {
    assert.ok(alerts.length > 0);
  });

  for (const [, name, body] of alerts) {
    it(`${name} queries error events only`, () => {
      assert.match(body, /dataset\s*=\s*"events"/);
      assert.match(body, /event_types\s*=\s*\["error"\]/);
    });

    it(`${name} relies on no signal the runtime never emits`, () => {
      assert.doesNotMatch(body, /transaction|d:custom|failure_rate|\(user\)/);
    });
  }
});
