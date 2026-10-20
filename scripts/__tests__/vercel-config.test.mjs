import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const readJson = (rel) =>
  JSON.parse(readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));

const APPS = ['web', 'studio'];

// Keys the two front-end projects are allowed to set. Anything else (a typo,
// or `headers` / `routes` / `rewrites` that would shadow next.config.ts and
// src/proxy.ts as the single source of the security headers) fails here.
const ALLOWED_KEYS = new Set([
  '$schema',
  'framework',
  'installCommand',
  'buildCommand',
  'ignoreCommand',
  'regions',
]);

// Vercel compute regions inside the EU (data residency, RGPD).
const EU_REGIONS = new Set(['cdg1', 'fra1', 'arn1', 'dub1']);

// Same major as the repo's turbo, pinned exactly so a new turbo-ignore
// release cannot change what Vercel skips. A turbo minor bump does not need
// to touch vercel.json.
const turboMajor = readJson('package.json')
  .devDependencies.turbo.replace(/^[\^~]/, '')
  .split('.')[0];

for (const app of APPS) {
  const config = readJson(`apps/${app}/vercel.json`);
  const pkgName = readJson(`apps/${app}/package.json`).name;

  test(`${app}: vercel.json only uses known keys`, () => {
    for (const key of Object.keys(config)) {
      assert.ok(ALLOWED_KEYS.has(key), `unexpected key "${key}" in apps/${app}/vercel.json`);
    }
  });

  test(`${app}: Next.js framework pinned to EU regions`, () => {
    assert.equal(config.framework, 'nextjs');
    assert.ok(Array.isArray(config.regions) && config.regions.length > 0);
    for (const region of config.regions) {
      assert.ok(EU_REGIONS.has(region), `region ${region} is outside the EU`);
    }
  });

  test(`${app}: installs the whole workspace from the root with a frozen lockfile`, () => {
    assert.equal(config.installCommand, 'cd ../.. && pnpm install --frozen-lockfile');
  });

  test(`${app}: builds through turbo filtered to its own package`, () => {
    assert.equal(config.buildCommand, `cd ../.. && pnpm exec turbo run build --filter=${pkgName}`);
  });

  test(`${app}: skips unrelated commits with a pinned turbo-ignore`, () => {
    const match = /^npx turbo-ignore@(\d+)\.\d+\.\d+ (\S+)$/.exec(config.ignoreCommand);
    assert.ok(match, `unexpected ignoreCommand: ${config.ignoreCommand}`);
    assert.equal(match[1], turboMajor);
    assert.equal(match[2], pkgName);
  });
}
