#!/usr/bin/env node
/**
 * Verify that all required Wrangler secrets are set on the target workers.
 *
 * Usage:
 *   node scripts/verify-secrets.mjs --env staging
 *   node scripts/verify-secrets.mjs --env production
 *
 * Exit 0 = all required secrets present. Exit 1 = one or more missing.
 *
 * This script NEVER prints secret values — it only checks presence via
 * `wrangler secret list`, which returns secret names only.
 *
 * Issue #328.
 */

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    env: { type: 'string' },
  },
});

const env = values.env;
if (env !== 'staging' && env !== 'production') {
  console.error('[verify-secrets] --env must be staging or production');
  process.exit(1);
}

// Required secrets per worker. Keyed by wrangler config file (undefined = main wrangler.toml).
const REQUIRED = {
  main: [
    'DB_URL',
    'REDIS_URL',
    'REDIS_TOKEN',
    'JWT_KID',
    'JWT_PRIVATE_KEY_PEM',
    'JWT_PUBLIC_KEY_PEM',
    'JWKS_JSON',
    'JWT_JWKS_URL',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'CRON_DB_URL',
  ],
  auth: [
    'DB_URL',
    'REDIS_URL',
    'REDIS_TOKEN',
    'JWT_KID',
    'JWT_PRIVATE_KEY_PEM',
    'JWT_PUBLIC_KEY_PEM',
    'JWKS_JSON',
    'JWT_JWKS_URL',
    'RESEND_API_KEY',
  ],
  reservations: [
    'DB_URL',
    'REDIS_URL',
    'REDIS_TOKEN',
    'JWT_KID',
    'JWT_PRIVATE_KEY_PEM',
    'JWT_PUBLIC_KEY_PEM',
    'JWKS_JSON',
    'JWT_JWKS_URL',
  ],
  billing: [
    'DB_URL',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'JWT_KID',
    'JWT_PRIVATE_KEY_PEM',
    'JWT_PUBLIC_KEY_PEM',
    'JWKS_JSON',
    'JWT_JWKS_URL',
  ],
};

const CONFIG_FILES = {
  main: undefined,
  auth: 'wrangler.auth.toml',
  reservations: 'wrangler.reservations.toml',
  billing: 'wrangler.billing.toml',
};

/**
 * @param {string | undefined} configFile
 * @param {string} envName
 * @returns {Set<string>} set of secret names present on the worker
 */
function listSecrets(configFile, envName) {
  const wranglerArgs = ['secret', 'list', '--env', envName, '--json'];
  if (configFile !== undefined) wranglerArgs.unshift('-c', configFile);

  try {
    // Use execFileSync with an argument array — no shell interpolation, safe for user-supplied envName.
    const output = execFileSync(
      'pnpm',
      ['--filter', '@athlya/api', 'exec', 'wrangler', ...wranglerArgs],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    // wrangler outputs JSON array of { name: string, type: string }
    const parsed = JSON.parse(output.trim());
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map((s) => s.name));
  } catch (err) {
    console.error(`[verify-secrets] Failed to list secrets for ${configFile ?? 'main'} --env ${envName}`);
    console.error(String(err));
    return new Set();
  }
}

let anyMissing = false;

for (const [worker, required] of Object.entries(REQUIRED)) {
  const configFile = CONFIG_FILES[worker];
  const present = listSecrets(configFile, env);
  const missing = required.filter((name) => !present.has(name));

  if (missing.length > 0) {
    console.error(`[verify-secrets] MISSING on ${worker} (${env}): ${missing.join(', ')}`);
    anyMissing = true;
  } else {
    console.log(`[verify-secrets] OK    ${worker} (${env}): all ${required.length} secrets present`);
  }
}

if (anyMissing) {
  console.error('[verify-secrets] One or more secrets are missing. Run: wrangler secret put <NAME> --env ' + env);
  process.exit(1);
}

console.log(`[verify-secrets] All secrets verified for ${env}`);
