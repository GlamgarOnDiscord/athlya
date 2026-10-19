import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { datasetMismatch, tailDatasetForEnv } from '../axiom-tail-dataset.mjs';
import { CONFIG_FILES, TAIL_REQUIRED } from '../verify-secrets.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'packages', 'api');
const read = (...parts) => readFileSync(path.join(...parts), 'utf8');
const TAIL_TOML = read(API, 'wrangler.axiom-tail.toml');
const ENVS = ['staging', 'production'];

/** `name` and `tail_consumers` services declared directly under `[env.<env>]`. */
function envTable(toml, env) {
  let inTable = false;
  let name = null;
  const services = [];
  for (const line of toml.split('\n')) {
    const header = /^\s*\[\[?([^\]]+)\]\]?/u.exec(line);
    if (header !== null) {
      inTable = header[1].trim() === `env.${env}`;
      continue;
    }
    if (!inTable) continue;
    const nameKey = /^\s*name\s*=\s*"([^"]+)"/u.exec(line);
    if (nameKey !== null) name = nameKey[1];
    if (/^\s*tail_consumers\s*=/u.test(line)) {
      for (const [, service] of line.matchAll(/service\s*=\s*"([^"]+)"/gu)) services.push(service);
    }
  }
  return { name, services };
}

describe('Axiom log Tail Worker wiring (issue #697)', () => {
  for (const env of ENVS) {
    it(`every API Worker tails to the ${env} tail Worker, which is declared`, () => {
      const tail = envTable(TAIL_TOML, env).name;
      assert.equal(tail, `athlya-axiom-tail-${env}`);
      for (const configFile of Object.values(CONFIG_FILES)) {
        const { services } = envTable(read(API, configFile ?? 'wrangler.toml'), env);
        assert.deepEqual(services, [tail], `${configFile ?? 'wrangler.toml'} --env ${env}`);
      }
    });

    it(`declares the ${env} logs dataset`, () => {
      assert.match(tailDatasetForEnv(TAIL_TOML, env) ?? '', /^[A-Za-z0-9._-]+$/u);
    });
  }

  it('never tails from preview or dev deploys (no tail Worker there)', () => {
    for (const configFile of Object.values(CONFIG_FILES)) {
      const toml = read(API, configFile ?? 'wrangler.toml');
      for (const env of ['preview', 'dev']) assert.deepEqual(envTable(toml, env).services, []);
    }
  });

  it('deploys the tail Worker before any API Worker', () => {
    const direct = read(ROOT, '.github', 'workflows', 'deploy-production.yml');
    for (const env of ENVS) {
      const deploys = [...direct.matchAll(/wrangler deploy (?:-c (\S+) )?--env (\w+)/gu)]
        .filter(([, , target]) => target === env)
        .map(([, config]) => config ?? 'wrangler.toml');
      assert.equal(deploys[0], 'wrangler.axiom-tail.toml', `deploy-production.yml ${env}`);
      assert.equal(deploys.filter((c) => c === 'wrangler.axiom-tail.toml').length, 1);
    }

    const canary = read(ROOT, '.github', 'workflows', 'canary.yml');
    const tail = canary.indexOf('wrangler deploy -c wrangler.axiom-tail.toml --env production');
    assert.ok(tail !== -1, 'canary.yml deploys the tail Worker');
    assert.ok(tail < canary.indexOf('canary-deploy.mjs upload'), 'before the gateway upload');
    assert.ok(tail < canary.indexOf('echo "${worker}=true"'), 'before the sub-workers');
  });

  it('checks the tail dataset against the monitors before deploying', () => {
    const direct = read(ROOT, '.github', 'workflows', 'deploy-production.yml');
    assert.ok(
      direct.indexOf('scripts/axiom-tail-dataset.mjs') <
        direct.indexOf('wrangler deploy -c wrangler.axiom-tail.toml --env staging'),
    );
  });

  it('documents the tail Worker secret it requires', () => {
    const { configFile, secrets } = TAIL_REQUIRED['axiom-tail'];
    assert.equal(configFile, 'wrangler.axiom-tail.toml');
    const header = TAIL_TOML.split('\n').findIndex((line) => line.startsWith('# Secrets'));
    assert.match(TAIL_TOML.split('\n')[header + 1] ?? '', new RegExp(secrets.join('|'), 'u'));
  });
});

describe('datasetMismatch', () => {
  it('passes when the tail Worker ships to the monitored dataset', () => {
    assert.equal(datasetMismatch('athlya-logs', ' athlya-logs '), null);
  });

  it('fails on an unset variable, a missing declaration or another dataset', () => {
    assert.match(datasetMismatch('athlya-logs', ''), /vars\.AXIOM_LOGS_DATASET is empty/u);
    assert.match(datasetMismatch('athlya-logs', undefined), /is empty/u);
    assert.match(datasetMismatch(null, 'athlya-logs'), /declares no AXIOM_LOGS_DATASET/u);
    assert.match(datasetMismatch('athlya-logs', 'other'), /ships to "athlya-logs"/u);
  });

  it('reads the dataset of one env only', () => {
    const toml =
      '[vars]\nAXIOM_LOGS_DATASET = "dev"\n[env.staging.vars]\nAXIOM_LOGS_DATASET = "s"\n';
    assert.equal(tailDatasetForEnv(toml, 'staging'), 's');
    assert.equal(tailDatasetForEnv(toml, 'production'), null);
  });
});
