#!/usr/bin/env node
/**
 * Assert that the production canary trigger covers the API bundle graph —
 * issue #404.
 *
 * `canary.yml` only runs when its `paths:` filter matches. Any workspace
 * package that `@athlya/api` reaches through runtime `dependencies` changes
 * the deployed Worker bundle, so its directory must be in that filter, as
 * must the lockfile (it pins every third-party module in the bundle).
 *
 * Usage: node scripts/check-canary-paths.mjs   (exit 1 on a gap)
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Files outside packages/ that change the deployed API artifact. */
export const REQUIRED_EXTRA_PATHS = ['pnpm-lock.yaml', 'pnpm-workspace.yaml'];

/**
 * @param {Record<string, { dir: string, dependencies: string[] }>} workspace
 *   package name → its directory and runtime `@athlya/*` dependencies
 * @param {string} rootName
 * @returns {string[]} directories of `rootName` and everything it reaches
 */
export function runtimeClosure(workspace, rootName) {
  const seen = new Set();
  const stack = [rootName];
  while (stack.length > 0) {
    const name = stack.pop();
    if (seen.has(name) || !workspace[name]) continue;
    seen.add(name);
    stack.push(...workspace[name].dependencies);
  }
  return [...seen].map((name) => workspace[name].dir).sort();
}

/**
 * Extract the `on.push.paths` entries of a workflow. Deliberately tiny:
 * the canary workflow keeps one quoted path per line.
 *
 * @param {string} workflowYaml
 * @returns {string[]}
 */
export function parsePushPaths(workflowYaml) {
  const lines = workflowYaml.split('\n');
  const start = lines.findIndex((line) => /^\s{4}paths:\s*$/.test(line));
  if (start === -1) return [];
  const paths = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s{6}-\s+['"]?([^'"]+)['"]?\s*$/.exec(line);
    if (!match) break;
    paths.push(match[1]);
  }
  return paths;
}

/**
 * @param {string[]} triggerPaths
 * @param {string[]} requiredPaths  directories (covered by `dir/**`) or files
 * @returns {string[]} required entries the trigger does not cover
 */
export function findUncovered(triggerPaths, requiredPaths) {
  const triggers = new Set(triggerPaths);
  return requiredPaths.filter((required) =>
    required.includes('.') && !required.includes('/')
      ? !triggers.has(required)
      : !triggers.has(`${required}/**`),
  );
}

function loadWorkspace() {
  /** @type {Record<string, { dir: string, dependencies: string[] }>} */
  const workspace = {};
  for (const entry of readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = `packages/${entry.name}`;
    const pkg = JSON.parse(readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'));
    workspace[pkg.name] = {
      dir,
      dependencies: Object.keys(pkg.dependencies ?? {}).filter((dep) => dep.startsWith('@athlya/')),
    };
  }
  return workspace;
}

if (import.meta.main) {
  const required = [...runtimeClosure(loadWorkspace(), '@athlya/api'), ...REQUIRED_EXTRA_PATHS];
  const triggers = parsePushPaths(
    readFileSync(path.join(ROOT, '.github/workflows/canary.yml'), 'utf8'),
  );
  const missing = findUncovered(triggers, required);
  if (missing.length > 0) {
    for (const entry of missing) {
      console.error(
        `::error file=.github/workflows/canary.yml::canary trigger does not cover ${entry}`,
      );
    }
    process.exit(1);
  }
  console.log(`[check-canary-paths] OK — ${required.length} bundle inputs covered`);
}
