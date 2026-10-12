import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  evaluateErrorBudget,
  fetchReleaseErrorCount,
  readErrorBudgetConfig,
} from '../canary-error-budget.mjs';
import { findUncovered, parsePushPaths, runtimeClosure } from '../check-canary-paths.mjs';

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
    assert.match(requested.url.searchParams.get('query'), /release:"abc123"/);
    assert.equal(requested.url.searchParams.get('start'), '2026-10-12T10:00:00.000Z');
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

  it('defaults the budget to 5 errors', () => {
    const result = readErrorBudgetConfig({
      SENTRY_ORG: 'o',
      SENTRY_PROJECT: 'p',
      SENTRY_AUTH_TOKEN: 't',
      VERSION: 'v',
    });
    assert.equal(result.ok, true);
    assert.equal(result.config.maxErrors, 5);
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
