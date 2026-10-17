#!/usr/bin/env node
/**
 * Assert that the production canary trigger covers every input of the
 * deployed API artifact and of the canary pipeline itself — issue #404.
 *
 * `canary.yml` only runs when its `paths:` filter matches. It must cover:
 *   • every workspace package `@athlya/api` reaches through runtime
 *     `dependencies` (they are bundled into the Worker);
 *   • the build-config packages those packages extend (`@athlya/tsconfig`:
 *     esbuild reads the tsconfig chain when wrangler bundles the Worker);
 *   • the lockfile and workspace manifest (they pin every bundled module);
 *   • the workflow itself, every script it runs, and every local module
 *     those scripts import.
 *
 * Usage: node scripts/check-canary-paths.mjs   (exit 1 on a gap)
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = '.github/workflows/canary.yml';

/** Files outside packages/ that change the deployed API artifact. */
export const REQUIRED_EXTRA_PATHS = ['pnpm-lock.yaml', 'pnpm-workspace.yaml'];

/**
 * Workspace devDependencies that feed the Worker build. ESLint config is
 * deliberately absent: it never reaches the bundle.
 */
export const BUILD_CONFIG_PACKAGES = new Set(['@athlya/tsconfig']);

/**
 * @param {Record<string, { dir: string, dependencies: string[], devDependencies?: string[] }>} workspace
 *   package name → its directory and `@athlya/*` dependencies
 * @param {string} rootName
 * @returns {string[]} directories of `rootName`, everything it reaches at
 *   runtime, and the build-config packages those extend
 * @throws when a reached package is not in `workspace` (fail closed)
 */
export function runtimeClosure(workspace, rootName) {
  const seen = new Set();
  const stack = [rootName];
  while (stack.length > 0) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    const node = workspace[name];
    if (!node) {
      throw new Error(`workspace package ${name} not found — cannot prove canary coverage`);
    }
    seen.add(name);
    stack.push(...node.dependencies);
    stack.push(...(node.devDependencies ?? []).filter((dep) => BUILD_CONFIG_PACKAGES.has(dep)));
  }
  return [...seen].map((name) => workspace[name].dir).sort();
}

/**
 * Repository scripts a workflow runs (`scripts/<name>.mjs|.sh`), ignoring
 * comment lines.
 *
 * @param {string} workflowYaml
 * @returns {string[]}
 */
export function workflowScripts(workflowYaml) {
  const scripts = new Set();
  for (const line of workflowYaml.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    for (const match of line.matchAll(/\bscripts\/[\w./-]+\.(?:mjs|sh)\b/g)) {
      scripts.add(match[0]);
    }
  }
  return [...scripts].sort();
}

/**
 * Relative ES module specifiers imported by `source`.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function localImports(source) {
  return [...source.matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g)].map((match) => match[1]);
}

/**
 * @param {string[]} entries repository-relative script paths
 * @param {(file: string) => string} readFile
 * @returns {string[]} the entries plus every local module they import
 */
export function scriptClosure(entries, readFile) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.endsWith('.mjs')) continue;
    for (const specifier of localImports(readFile(file))) {
      stack.push(path.posix.join(path.posix.dirname(file), specifier));
    }
  }
  return [...seen].sort();
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
 * @param {string[]} requiredPaths  directories (covered by `dir/**`) or
 *   files (a basename with an extension, matched exactly)
 * @returns {string[]} required entries the trigger does not cover
 */
export function findUncovered(triggerPaths, requiredPaths) {
  const triggers = new Set(triggerPaths);
  return requiredPaths.filter((required) =>
    path.posix.basename(required).includes('.')
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
    if (!existsSync(path.join(ROOT, dir, 'package.json'))) continue;
    const pkg = JSON.parse(readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'));
    const workspaceDeps = (deps) =>
      Object.keys(deps ?? {}).filter((dep) => dep.startsWith('@athlya/'));
    workspace[pkg.name] = {
      dir,
      dependencies: workspaceDeps(pkg.dependencies),
      devDependencies: workspaceDeps(pkg.devDependencies),
    };
  }
  return workspace;
}

if (import.meta.main) {
  const workflowYaml = readFileSync(path.join(ROOT, WORKFLOW), 'utf8');
  const readRepoFile = (file) => readFileSync(path.join(ROOT, file), 'utf8');
  const required = [
    ...runtimeClosure(loadWorkspace(), '@athlya/api'),
    ...REQUIRED_EXTRA_PATHS,
    WORKFLOW,
    ...scriptClosure(workflowScripts(workflowYaml), readRepoFile),
  ];
  const triggers = parsePushPaths(workflowYaml);
  const missing = findUncovered(triggers, required);
  if (missing.length > 0) {
    for (const entry of missing) {
      console.error(`::error file=${WORKFLOW}::canary trigger does not cover ${entry}`);
    }
    process.exit(1);
  }
  console.log(`[check-canary-paths] OK — ${required.length} bundle inputs covered`);
}
