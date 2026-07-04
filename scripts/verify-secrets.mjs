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
 * Issues #328, #410.
 *
 * Secret tiers
 * ------------
 * REQUIRED   — missing in either env fails the check immediately.
 * PRODUCTION — missing only on production fails the check.
 *              On staging, missing secrets are warned but not fatal.
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

const isProduction = env === 'production';

// Core secrets required in every environment.
const CORE_JWT = [
  'JWT_KID',
  'JWT_PRIVATE_KEY_PEM',
  'JWT_PUBLIC_KEY_PEM',
  'JWKS_JSON',
  'JWT_JWKS_URL',
];
const CORE_DB = ['DB_URL'];
const CORE_REDIS = ['REDIS_URL', 'REDIS_TOKEN'];

// Required in both staging and production.
const REQUIRED = {
  main: [
    ...CORE_DB,
    ...CORE_REDIS,
    ...CORE_JWT,
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'CRON_DB_URL',
    'TURNSTILE_SECRET',
    'CORS_ORIGIN',
  ],
  auth: [...CORE_DB, ...CORE_REDIS, ...CORE_JWT, 'RESEND_API_KEY'],
  reservations: [...CORE_DB, ...CORE_REDIS, ...CORE_JWT],
  billing: [...CORE_DB, ...CORE_JWT, 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
};

// Additional secrets required in production only.
// Missing on staging emits ::warning:: but does not fail.
const PRODUCTION_REQUIRED = {
  main: [
    'SENTRY_DSN',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_HEADERS',
    'CF_ACCESS_AUD',
    'CF_ACCESS_CERTS_URL',
  ],
  auth: ['SENTRY_DSN', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS'],
  reservations: ['SENTRY_DSN', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS'],
  billing: ['SENTRY_DSN', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS'],
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
    const output = execFileSync(
      'pnpm',
      ['--filter', '@athlya/api', 'exec', 'wrangler', ...wranglerArgs],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const parsed = JSON.parse(output.trim());
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map((s) => s.name));
  } catch (err) {
    console.error(
      `[verify-secrets] Failed to list secrets for ${configFile ?? 'main'} --env ${envName}`,
    );
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
    console.log(`[verify-secrets] OK    ${worker} (${env}): all ${required.length} required secrets present`);
  }

  const productionRequired = PRODUCTION_REQUIRED[worker] ?? [];
  if (productionRequired.length > 0) {
    const missingProd = productionRequired.filter((name) => !present.has(name));
    if (missingProd.length > 0) {
      if (isProduction) {
        console.error(
          `[verify-secrets] MISSING (production-required) on ${worker}: ${missingProd.join(', ')}`,
        );
        anyMissing = true;
      } else {
        console.warn(
          `[verify-secrets] WARN  ${worker} (staging): not set (optional on staging, required on production): ${missingProd.join(', ')}`,
        );
      }
    } else {
      console.log(
        `[verify-secrets] OK    ${worker} (${env}): all ${productionRequired.length} observability/access secrets present`,
      );
    }
  }
}

if (anyMissing) {
  console.error(
    '[verify-secrets] One or more secrets are missing. Run: wrangler secret put <NAME> --env ' + env,
  );
  process.exit(1);
}

console.log(`[verify-secrets] All secrets verified for ${env}.`);
