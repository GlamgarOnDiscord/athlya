import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parseQueueList, queuesForEnv } from '../wrangler-queues.mjs';

const read = (file) => readFileSync(new URL(`../../packages/api/${file}`, import.meta.url), 'utf8');

test('queuesForEnv keeps only the queues of the requested env', () => {
  const toml = `
[[queues.producers]]
binding = "OUTBOX_KICK_QUEUE"
queue = "athlya-outbox-kick"

[[env.staging.queues.producers]]
binding = "OUTBOX_KICK_QUEUE"
queue = "athlya-outbox-kick-staging"

[[env.staging.queues.consumers]]
queue = "athlya-events-staging"
dead_letter_queue = "athlya-events-staging-dlq"

[env.staging.vars]
queue = "not-a-binding"

[[env.production.queues.producers]]
queue = "athlya-outbox-kick"

[[env.production.queues.consumers]]
queue = 'athlya-single-quoted'
`;
  assert.deepEqual(queuesForEnv(toml, 'staging'), [
    'athlya-events-staging',
    'athlya-events-staging-dlq',
    'athlya-outbox-kick-staging',
  ]);
  assert.deepEqual(queuesForEnv(toml, 'production'), [
    'athlya-outbox-kick',
    'athlya-single-quoted',
  ]);
});

test('every Worker that writes outbox rows declares the kick producer (issue #311)', () => {
  const expected = { staging: 'athlya-outbox-kick-staging', production: 'athlya-outbox-kick' };
  for (const file of [
    'wrangler.toml',
    'wrangler.auth.toml',
    'wrangler.reservations.toml',
    'wrangler.billing.toml',
  ]) {
    const toml = read(file);
    for (const [env, queue] of Object.entries(expected)) {
      assert.ok(queuesForEnv(toml, env).includes(queue), `${file} --env ${env} lacks ${queue}`);
    }
  }
});

test('parseQueueList matches exact names, not prefixes', () => {
  const output = `
┌──────────────────────────────────┬────────────────────────────┬───────────┐
│ id                               │ name                       │ producers │
├──────────────────────────────────┼────────────────────────────┼───────────┤
│ 0f1e2d3c4b5a69788796a5b4c3d2e1f0 │ athlya-outbox-kick-staging │ 3         │
└──────────────────────────────────┴────────────────────────────┴───────────┘`;
  const names = parseQueueList(output);
  assert.ok(names.has('athlya-outbox-kick-staging'));
  assert.ok(!names.has('athlya-outbox-kick'));
});
