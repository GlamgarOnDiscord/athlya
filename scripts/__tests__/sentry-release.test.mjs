import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'sentry-release.sh');

function run(args, env = {}) {
  const base = { PATH: process.env.PATH ?? '', GITHUB_SHA: '0123456789abcdef' };
  return spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...base, ...env } });
}

function workflow(name) {
  return readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

describe('sentry-release.sh configuration gate (#415)', () => {
  it('fails closed in production when Sentry config is missing', () => {
    for (const mode of ['prepare', 'finalize', 'all']) {
      const result = run([mode, 'production'], { SENTRY_ORG: 'athlya', SENTRY_PROJECT: 'api' });
      assert.equal(result.status, 1, `${mode}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /SENTRY_AUTH_TOKEN/);
    }
  });

  it('only warns in staging', () => {
    const result = run(['all', 'staging']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /::warning::/);
  });

  it('rejects an unknown mode or environment', () => {
    assert.equal(run(['upload', 'production']).status, 2);
    assert.equal(run(['all', 'preview']).status, 2);
  });
});

/**
 * Every path that ships a production Worker version uploads source maps
 * and records the Sentry release (#415).
 */
describe('production deploy paths wire Sentry releases', () => {
  const index = (text, needle) => {
    const at = text.indexOf(needle);
    assert.notEqual(at, -1, `missing: ${needle}`);
    return at;
  };

  it('canary.yml uploads maps before promotion and finalizes after', () => {
    const yaml = workflow('canary.yml');
    const upload = index(yaml, 'canary-deploy.mjs upload --env production');
    const prepare = index(yaml, 'sentry-release.sh prepare production');
    const promote = index(yaml, 'canary-deploy.mjs production-canary');
    const finalize = index(yaml, 'sentry-release.sh finalize production');
    assert.ok(upload < prepare && prepare < promote && promote < finalize);
    assert.match(yaml, /--outdir dist\b/);
    assert.match(yaml, /--outdir "dist\/\$\{worker\}"/);
    assert.match(yaml, /--version-id "\$\{GATEWAY_VERSION_ID\}"/);
  });

  it('deploy-production.yml covers production-deploy and production-canary', () => {
    const yaml = workflow('deploy-production.yml');
    index(yaml, 'sentry-release.sh all "${DEPLOY_ENV_NAME}"');
    const upload = index(yaml, 'canary-deploy.mjs upload --env production');
    const prepare = index(yaml, 'sentry-release.sh prepare production');
    const promote = index(yaml, 'canary-deploy.mjs production-canary');
    const finalize = index(yaml, 'sentry-release.sh finalize production');
    assert.ok(upload < prepare && prepare < promote && promote < finalize);
    assert.match(yaml, /--version-id "\$\{GATEWAY_VERSION_ID\}"/);
  });

  it('no workflow keeps an inline sentry-cli upload', () => {
    for (const name of ['canary.yml', 'deploy-production.yml']) {
      assert.doesNotMatch(workflow(name), /sentry-cli/);
    }
  });
});
