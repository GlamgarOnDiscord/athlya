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
 * Every path that ships a production API Worker version (canary.yml and
 * deploy-production.yml) uploads source maps and records the Sentry
 * release (#415). The web/studio frontends (deploy-frontend.yml) are a
 * separate application and out of this contract.
 */
describe('API production deploy paths wire Sentry releases', () => {
  const index = (text, needle) => {
    const at = text.indexOf(needle);
    assert.notEqual(at, -1, `missing: ${needle}`);
    return at;
  };

  it('canary.yml uploads every map before any new code takes traffic', () => {
    const yaml = workflow('canary.yml');
    const bundle = index(yaml, '--outdir "dist/${worker}" --dry-run');
    const upload = index(yaml, 'canary-deploy.mjs upload --env production');
    const prepare = index(yaml, 'sentry-release.sh prepare production');
    const deploy = index(yaml, '--var "VERSION:${VERSION}" --outdir "dist/${worker}"\n');
    const promote = index(yaml, 'canary-deploy.mjs production-canary');
    const finalize = index(yaml, 'sentry-release.sh finalize production');
    assert.ok(bundle < upload && upload < prepare && prepare < deploy);
    assert.ok(deploy < promote && promote < finalize);
    assert.match(yaml, /--outdir dist\b/);
    assert.match(yaml, /--version-id "\$\{GATEWAY_VERSION_ID\}"/);
  });

  it('deploy-production.yml covers production-deploy and production-canary', () => {
    const yaml = workflow('deploy-production.yml');
    const precheck = index(yaml, 'name: Require Sentry release config (production-deploy)');
    const firstDeploy = index(yaml, 'name: Run DB migrations (production)');
    assert.ok(precheck < firstDeploy, 'Sentry config must be checked before anything ships');
    index(yaml, 'sentry-release.sh all "${DEPLOY_ENV_NAME}"');
    const upload = index(yaml, 'canary-deploy.mjs upload --env production');
    const prepare = index(yaml, 'sentry-release.sh prepare production');
    const promote = index(yaml, 'canary-deploy.mjs production-canary');
    const finalize = index(yaml, 'sentry-release.sh finalize production');
    assert.ok(upload < prepare && prepare < promote && promote < finalize);
    assert.match(yaml, /--version-id "\$\{GATEWAY_VERSION_ID\}"/);
  });

  it('both API production workflows verify the Worker telemetry secrets', () => {
    assert.match(
      workflow('deploy-production.yml'),
      /if: inputs\.phase == 'production-deploy' \|\| inputs\.phase == 'production-canary'\n\s+run: node scripts\/verify-secrets\.mjs --env production/,
    );
    assert.match(workflow('canary.yml'), /node scripts\/verify-secrets\.mjs --env production/);
  });

  it('neither API production workflow keeps an inline sentry-cli upload', () => {
    for (const name of ['canary.yml', 'deploy-production.yml']) {
      assert.doesNotMatch(workflow(name), /sentry-cli/);
    }
  });
});
