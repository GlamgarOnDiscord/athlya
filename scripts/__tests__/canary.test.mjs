import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  evaluateErrorBudget,
  fetchReleaseErrorCount,
  readErrorBudgetConfig,
} from '../canary-error-budget.mjs';
import {
  findUncovered,
  localImports,
  parsePushPaths,
  runtimeClosure,
  scriptClosure,
  workflowScripts,
} from '../check-canary-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('evaluateErrorBudget', () => {
  it('passes within the budget and fails above it', () => {
    assert.equal(evaluateErrorBudget({ errorCount: 5, maxErrors: 5 }).ok, true);
    assert.equal(evaluateErrorBudget({ errorCount: 6, maxErrors: 5 }).ok, false);
  });

  it('fails closed when the count is unavailable', () => {
    assert.equal(evaluateErrorBudget({ errorCount: Number.NaN, maxErrors: 5 }).ok, false);
  });
});

describe('fetchReleaseErrorCount', () => {
  const base = {
    org: 'athlya',
    project: 'api',
    release: 'abc123',
    start: new Date('2026-10-12T10:00:00Z'),
    end: new Date('2026-10-12T10:10:00Z'),
    token: 'tok',
  };

  it('queries errors for the release and window', async () => {
    let requested;
    const count = await fetchReleaseErrorCount({
      ...base,
      fetchImpl: async (url, init) => {
        requested = { url: new URL(url), auth: init.headers.authorization };
        return new Response(JSON.stringify({ data: [{ 'count()': 3 }] }));
      },
    });
    assert.equal(count, 3);
    assert.equal(requested.url.pathname, '/api/0/organizations/athlya/events/');
    const query = requested.url.searchParams.get('query');
    assert.match(query, /release:"abc123"/);
    assert.match(query, /(^|\s)project:api(\s|$)/);
    assert.match(query, /event\.type:error/);
    assert.equal(requested.url.searchParams.get('start'), '2026-10-12T10:00:00.000Z');
    assert.equal(requested.url.searchParams.get('end'), '2026-10-12T10:10:00.000Z');
    assert.equal(requested.auth, 'Bearer tok');
  });

  it('returns NaN on API errors and malformed bodies', async () => {
    const failing = await fetchReleaseErrorCount({
      ...base,
      fetchImpl: async () => new Response('nope', { status: 500 }),
    });
    const malformed = await fetchReleaseErrorCount({
      ...base,
      fetchImpl: async () => new Response(JSON.stringify({ data: [] })),
    });
    assert.ok(Number.isNaN(failing));
    assert.ok(Number.isNaN(malformed));
  });
});

describe('readErrorBudgetConfig', () => {
  it('reports every missing value', () => {
    const result = readErrorBudgetConfig({});
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, [
      'SENTRY_ORG',
      'SENTRY_PROJECT',
      'SENTRY_AUTH_TOKEN',
      'VERSION',
    ]);
  });

  const complete = {
    SENTRY_ORG: 'o',
    SENTRY_PROJECT: 'p',
    SENTRY_AUTH_TOKEN: 't',
    VERSION: 'v',
  };

  it('defaults the budget to 5 errors', () => {
    const result = readErrorBudgetConfig(complete);
    assert.equal(result.ok, true);
    assert.equal(result.config.maxErrors, 5);
  });

  it('treats an empty CANARY_MAX_ERRORS (unset repository variable) as the default', () => {
    for (const value of ['', '  ']) {
      const result = readErrorBudgetConfig({ ...complete, CANARY_MAX_ERRORS: value });
      assert.equal(result.ok, true);
      assert.equal(result.config.maxErrors, 5);
    }
  });

  it('accepts a non-negative integer budget, zero included', () => {
    assert.equal(
      readErrorBudgetConfig({ ...complete, CANARY_MAX_ERRORS: '0' }).config.maxErrors,
      0,
    );
    assert.equal(
      readErrorBudgetConfig({ ...complete, CANARY_MAX_ERRORS: '12' }).config.maxErrors,
      12,
    );
  });

  it('fails validation on a malformed budget instead of falling back', () => {
    for (const value of ['abc', '-1', '1.5', '5e2', 'Infinity']) {
      const result = readErrorBudgetConfig({ ...complete, CANARY_MAX_ERRORS: value });
      assert.equal(result.ok, false, value);
      assert.deepEqual(result.missing, []);
      assert.match(result.invalid[0], /CANARY_MAX_ERRORS/);
    }
  });
});

describe('check-canary-paths', () => {
  const workspace = {
    '@athlya/api': { dir: 'packages/api', dependencies: ['@athlya/db'] },
    '@athlya/db': { dir: 'packages/db', dependencies: ['@athlya/shared'] },
    '@athlya/shared': { dir: 'packages/shared', dependencies: [] },
    '@athlya/unrelated': { dir: 'packages/unrelated', dependencies: [] },
  };

  it('follows runtime dependencies transitively', () => {
    assert.deepEqual(runtimeClosure(workspace, '@athlya/api'), [
      'packages/api',
      'packages/db',
      'packages/shared',
    ]);
  });

  it('fails closed on a package missing from the workspace', () => {
    assert.throws(
      () =>
        runtimeClosure(
          { '@athlya/api': { dir: 'packages/api', dependencies: ['@athlya/ghost'] } },
          '@athlya/api',
        ),
      /@athlya\/ghost not found/,
    );
    assert.throws(() => runtimeClosure({}, '@athlya/api'), /@athlya\/api not found/);
  });

  it('follows build-config devDependencies but not lint-only ones', () => {
    assert.deepEqual(
      runtimeClosure(
        {
          '@athlya/api': {
            dir: 'packages/api',
            dependencies: [],
            devDependencies: ['@athlya/tsconfig', '@athlya/eslint-config'],
          },
          '@athlya/tsconfig': { dir: 'packages/tsconfig', dependencies: [] },
          '@athlya/eslint-config': { dir: 'packages/eslint-config', dependencies: [] },
        },
        '@athlya/api',
      ),
      ['packages/api', 'packages/tsconfig'],
    );
  });

  it('collects the scripts a workflow runs and their local imports', () => {
    const yaml = [
      '# header mentioning scripts/not-run.mjs',
      '      - run: node scripts/a.mjs --flag',
      '        run: bash scripts/wait.sh "$URL"',
    ].join('\n');
    assert.deepEqual(workflowScripts(yaml), ['scripts/a.mjs', 'scripts/wait.sh']);
    assert.deepEqual(localImports("import { x } from './b.mjs';\nimport fs from 'node:fs';"), [
      './b.mjs',
    ]);
    const files = {
      'scripts/a.mjs': "import { b } from './b.mjs';",
      'scripts/b.mjs': "export { c } from './lib/c.mjs';",
      'scripts/lib/c.mjs': '',
    };
    assert.deepEqual(
      scriptClosure(['scripts/a.mjs', 'scripts/wait.sh'], (f) => files[f]),
      ['scripts/a.mjs', 'scripts/b.mjs', 'scripts/lib/c.mjs', 'scripts/wait.sh'],
    );
  });

  it('treats nested files as files, not directories', () => {
    assert.deepEqual(
      findUncovered(
        ['scripts/a.mjs', 'packages/api/**'],
        ['scripts/a.mjs', 'scripts/b.mjs', 'packages/api'],
      ),
      ['scripts/b.mjs'],
    );
  });

  it('parses push paths and reports uncovered inputs', () => {
    const yaml = [
      'on:',
      '  push:',
      '    branches:',
      '      - master',
      '    paths:',
      "      - 'packages/api/**'",
      "      - 'packages/db/**'",
      "      - 'pnpm-lock.yaml'",
      '',
      'jobs:',
    ].join('\n');
    const triggers = parsePushPaths(yaml);
    assert.deepEqual(triggers, ['packages/api/**', 'packages/db/**', 'pnpm-lock.yaml']);
    assert.deepEqual(
      findUncovered(triggers, ['packages/api', 'packages/db', 'packages/shared', 'pnpm-lock.yaml']),
      ['packages/shared'],
    );
  });
});

describe('workflow wrangler --var syntax', () => {
  // wrangler splits `--var` on ':' — `--var KEY=VALUE` silently creates a
  // variable literally named "KEY=VALUE" and leaves KEY unchanged.
  it('never passes --var KEY=VALUE', () => {
    const dir = path.join(ROOT, '.github', 'workflows');
    const offenders = [];
    for (const file of readdirSync(dir).filter((name) => /\.ya?ml$/.test(name))) {
      readFileSync(path.join(dir, file), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (/--var[\s=]+["']?[A-Za-z_][A-Za-z0-9_]*=/.test(line)) {
            offenders.push(`${file}:${index + 1}`);
          }
        });
    }
    assert.deepEqual(offenders, []);
  });
});
