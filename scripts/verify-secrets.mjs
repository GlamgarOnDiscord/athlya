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
 * Issues #328, #410, #343, #311.
 *
 * Each Worker inherits no secret from another (separate wrangler configs),
 * so every list below mirrors what that Worker reads at runtime:
 *   - assertRequiredSecrets() (domain-deps.ts) — DB_URL, REDIS_URL,
 *     REDIS_TOKEN, JWT_JWKS_URL, JWT_KID on every Worker;
 *   - CORS_ORIGIN — base-app.ts refuses cross-origin requests without it;
 *   - auth: signing keys, TURNSTILE_SECRET (/login, /register), RESEND_API_KEY;
 *   - reservations: EXPORT_URL_SIGNING_KEY (/v1/members/me/export download);
 *   - billing: Stripe checkout + webhook (STRIPE_*, BILLING_REDIRECT_URL,
 *     BILLING_DB_URL) and /admin/* (JWT rotation keys, CF Access);
 *   - main gateway: cron (CRON_DB_URL), queue consumers (RESEND_API_KEY,
 *     EXPORT_URL_SIGNING_KEY) and the Stripe fallback on *.workers.dev.
 * scripts/__tests__/verify-secrets.test.mjs cross-checks these lists against
 * domain-deps.ts and the `# Secrets` header of each wrangler config.
 *
 * Also checks that every queue the four Wrangler configs bind for the
 * target env exists (`wrangler queues list`), so a queue that was never
 * created — e.g. the outbox kick queue (issue #311) — fails here instead
 * of half-way through the multi-Worker deploy.
 *
 * Secret tiers
 * ------------
 * REQUIRED   — missing in either env fails the check immediately.
 * PRODUCTION — missing only on production fails the check.
 *              On staging, missing secrets are warned but not fatal.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { parseQueueList, queuesForEnv } from './wrangler-queues.mjs';

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
const BILLING_STRIPE = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_ID_PRO',
  'BILLING_REDIRECT_URL',
  'BILLING_DB_URL',
];
const OBSERVABILITY = ['SENTRY_DSN', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS'];
const CF_ACCESS = ['CF_ACCESS_AUD', 'CF_ACCESS_CERTS_URL'];

/** Required in both staging and production. */
export const REQUIRED = {
  main: [
    ...CORE_DB,
    ...CORE_REDIS,
    ...CORE_JWT,
    ...BILLING_STRIPE,
    'CRON_DB_URL',
    'TURNSTILE_SECRET',
    'CORS_ORIGIN',
    'RESEND_API_KEY',
    'EXPORT_URL_SIGNING_KEY',
  ],
  auth: [
    ...CORE_DB,
    ...CORE_REDIS,
    ...CORE_JWT,
    'CORS_ORIGIN',
    'TURNSTILE_SECRET',
    'RESEND_API_KEY',
  ],
  reservations: [...CORE_DB, ...CORE_REDIS, ...CORE_JWT, 'CORS_ORIGIN', 'EXPORT_URL_SIGNING_KEY'],
  billing: [...CORE_DB, ...CORE_REDIS, ...CORE_JWT, 'CORS_ORIGIN', ...BILLING_STRIPE],
};

/**
 * Additional secrets required in production only.
 * Missing on staging emits a warning but does not fail.
 */
export const PRODUCTION_REQUIRED = {
  main: [...OBSERVABILITY, ...CF_ACCESS],
  auth: [...OBSERVABILITY],
  reservations: [...OBSERVABILITY],
  billing: [...OBSERVABILITY, ...CF_ACCESS],
};

export const CONFIG_FILES = {
  main: undefined,
  auth: 'wrangler.auth.toml',
  reservations: 'wrangler.reservations.toml',
  billing: 'wrangler.billing.toml',
};

/**
 * Compare the secrets present on one Worker with its required lists.
 * Pure so it can be unit-tested without wrangler.
 *
 * @param {string} worker key of REQUIRED
 * @param {Set<string>} present secret names reported by wrangler
 * @returns {{ missing: string[], missingProduction: string[] }}
 */
export function missingSecrets(worker, present) {
  const required = REQUIRED[worker] ?? [];
  const productionRequired = PRODUCTION_REQUIRED[worker] ?? [];
  return {
    missing: required.filter((name) => !present.has(name)),
    missingProduction: productionRequired.filter((name) => !present.has(name)),
  };
}

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

/**
 * Queue names the four Wrangler configs bind for `envName`.
 *
 * @param {string} envName
 * @returns {Set<string>}
 */
export function declaredQueues(envName) {
  const names = new Set();
  for (const configFile of Object.values(CONFIG_FILES)) {
    const toml = readFileSync(
      new URL(`../packages/api/${configFile ?? 'wrangler.toml'}`, import.meta.url),
      'utf8',
    );
    for (const name of queuesForEnv(toml, envName)) names.add(name);
  }
  return names;
}

/**
 * Names of the account's queues, across pages. `null` when listing fails
 * (the check then fails closed: a deploy would fail on the same call).
 *
 * @returns {Set<string> | null}
 */
function listQueues() {
  const names = new Set();
  for (let page = 1; page <= 20; page += 1) {
    let output;
    try {
      output = execFileSync(
        'pnpm',
        ['--filter', '@athlya/api', 'exec', 'wrangler', 'queues', 'list', '--page', String(page)],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (err) {
      console.error('[verify-secrets] Failed to list queues');
      console.error(String(err));
      return null;
    }
    const before = names.size;
    for (const name of parseQueueList(output)) names.add(name);
    if (names.size === before) break;
  }
  return names;
}

if (import.meta.main) {
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
  let anyMissing = false;

  for (const worker of Object.keys(REQUIRED)) {
    const present = listSecrets(CONFIG_FILES[worker], env);
    const { missing, missingProduction } = missingSecrets(worker, present);

    if (missing.length > 0) {
      console.error(`[verify-secrets] MISSING on ${worker} (${env}): ${missing.join(', ')}`);
      anyMissing = true;
    } else {
      console.log(
        `[verify-secrets] OK    ${worker} (${env}): all ${REQUIRED[worker].length} required secrets present`,
      );
    }

    const productionCount = PRODUCTION_REQUIRED[worker]?.length ?? 0;
    if (productionCount === 0) continue;
    if (missingProduction.length > 0) {
      if (isProduction) {
        console.error(
          `[verify-secrets] MISSING (production-required) on ${worker}: ${missingProduction.join(', ')}`,
        );
        anyMissing = true;
      } else {
        console.warn(
          `[verify-secrets] WARN  ${worker} (staging): not set (optional on staging, required on production): ${missingProduction.join(', ')}`,
        );
      }
    } else {
      console.log(
        `[verify-secrets] OK    ${worker} (${env}): all ${productionCount} observability/access secrets present`,
      );
    }
  }

  const existingQueues = listQueues();
  if (existingQueues === null) {
    anyMissing = true;
  } else {
    const missingQueues = [...declaredQueues(env)].filter((name) => !existingQueues.has(name));
    if (missingQueues.length > 0) {
      console.error(
        `[verify-secrets] MISSING queues (${env}): ${missingQueues.join(', ')} — create each with: wrangler queues create <name>`,
      );
      anyMissing = true;
    } else {
      console.log(`[verify-secrets] OK    queues (${env}): all bound queues exist`);
    }
  }

  if (anyMissing) {
    console.error(
      '[verify-secrets] One or more secrets are missing. Run: wrangler secret put <NAME> [-c <wrangler config>] --env ' +
        env,
    );
    process.exit(1);
  }

  console.log(`[verify-secrets] All secrets verified for ${env}.`);
}
