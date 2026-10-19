#!/usr/bin/env node
/**
 * Fail a deploy when the Axiom log Tail Worker (issue #697) ships to
 * another dataset than the one the Terraform monitors read.
 *
 * Usage:
 *   node scripts/axiom-tail-dataset.mjs --env staging --expected "$AXIOM_LOGS_DATASET"
 *
 * `--expected` is the GitHub environment variable `AXIOM_LOGS_DATASET`
 * (terraform.yml passes it as `axiom_logs_dataset`). The dataset the tail
 * Worker posts to is the `AXIOM_LOGS_DATASET` var of
 * `[env.<env>.vars]` in packages/api/wrangler.axiom-tail.toml.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const TABLE_HEADER = /^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$/;
const DATASET_KEY = /^\s*AXIOM_LOGS_DATASET\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/**
 * @param {string} toml  wrangler.axiom-tail.toml text.
 * @param {string} env   Named environment.
 * @returns {string | null} the dataset of that env, or null when not declared.
 */
export function tailDatasetForEnv(toml, env) {
  let inVars = false;
  for (const line of toml.split('\n')) {
    const header = TABLE_HEADER.exec(line);
    if (header !== null) {
      inVars = header[1].trim() === `env.${env}.vars`;
      continue;
    }
    const key = inVars ? DATASET_KEY.exec(line) : null;
    if (key !== null) return key[1] ?? key[2] ?? null;
  }
  return null;
}

/**
 * @param {string | null} declared
 * @param {string | undefined} expected
 * @returns {string | null} an error message, or null when they match.
 */
export function datasetMismatch(declared, expected) {
  if (expected === undefined || expected.trim() === '') {
    return 'vars.AXIOM_LOGS_DATASET is empty: set it on the GitHub environment (terraform.yml reads it too)';
  }
  if (declared === null)
    return 'wrangler.axiom-tail.toml declares no AXIOM_LOGS_DATASET for this env';
  if (declared !== expected.trim()) {
    return `wrangler.axiom-tail.toml ships to "${declared}" but the monitors read "${expected.trim()}"`;
  }
  return null;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { env: { type: 'string' }, expected: { type: 'string' } },
  });
  if (values.env !== 'staging' && values.env !== 'production') {
    console.error('[axiom-tail-dataset] --env must be staging or production');
    process.exit(1);
  }
  const toml = readFileSync(
    new URL('../packages/api/wrangler.axiom-tail.toml', import.meta.url),
    'utf8',
  );
  const declared = tailDatasetForEnv(toml, values.env);
  const error = datasetMismatch(declared, values.expected);
  if (error !== null) {
    console.error(`[axiom-tail-dataset] ${values.env}: ${error}`);
    process.exit(1);
  }
  console.log(`[axiom-tail-dataset] OK ${values.env}: ${declared}`);
}
