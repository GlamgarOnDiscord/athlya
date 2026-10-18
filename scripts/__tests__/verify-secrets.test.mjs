import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_FILES,
  OPTIONAL,
  PRODUCTION_REQUIRED,
  REQUIRED,
  declaredQueues,
  missingSecrets,
} from '../verify-secrets.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'packages', 'api');
const SECRET_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/gu;

/**
 * Secret names listed in a wrangler config header block that starts with
 * `# <label>` and continues on `#   ` lines.
 */
function headerSecrets(toml, label) {
  const lines = toml.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`# ${label}`));
  if (start === -1) return [];
  const block = [lines[start].slice(lines[start].indexOf(':') + 1)];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('#   ')) break;
    block.push(line);
  }
  return [...new Set(block.join(' ').match(SECRET_NAME) ?? [])];
}

function assertRequiredSecretNames() {
  const source = readFileSync(path.join(API, 'src', 'domain-deps.ts'), 'utf8');
  const start = source.indexOf('export function assertRequiredSecrets');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  return [...body.matchAll(/missing\.push\('([A-Z0-9_]+)'\)/gu)].map((m) => m[1]);
}

describe('verify-secrets lists', () => {
  it('require every secret assertRequiredSecrets() checks on every Worker', () => {
    const names = assertRequiredSecretNames();
    assert.ok(names.includes('DB_URL') && names.includes('JWT_KID'), 'parser found no names');
    for (const [worker, required] of Object.entries(REQUIRED)) {
      for (const name of names) {
        assert.ok(required.includes(name), `${worker} is missing ${name}`);
      }
    }
  });

  it('require CORS_ORIGIN everywhere (base-app refuses cross-origin requests without it)', () => {
    for (const [worker, required] of Object.entries(REQUIRED)) {
      assert.ok(required.includes('CORS_ORIGIN'), `${worker} is missing CORS_ORIGIN`);
    }
  });

  it('cover the billing Worker runtime (Stripe, athlya_billing, Redis, admin)', () => {
    for (const name of [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_PRICE_ID_PRO',
      'BILLING_REDIRECT_URL',
      'BILLING_DB_URL',
      'REDIS_URL',
      'REDIS_TOKEN',
    ]) {
      assert.ok(REQUIRED.billing.includes(name), `billing is missing ${name}`);
    }
    assert.ok(PRODUCTION_REQUIRED.billing.includes('CF_ACCESS_AUD'));
    assert.ok(PRODUCTION_REQUIRED.billing.includes('CF_ACCESS_CERTS_URL'));
  });

  it('require the export signing key where export links are signed and verified', () => {
    assert.ok(REQUIRED.main.includes('EXPORT_URL_SIGNING_KEY'));
    assert.ok(REQUIRED.reservations.includes('EXPORT_URL_SIGNING_KEY'));
  });

  it('keep the AI coach key optional on the Workers serving /v1/coach', () => {
    for (const worker of ['main', 'reservations']) {
      assert.ok(OPTIONAL[worker].includes('MISTRAL_API_KEY'), `${worker} is missing MISTRAL_API_KEY`);
      assert.ok(!REQUIRED[worker].includes('MISTRAL_API_KEY'));
    }
    assert.deepEqual(
      missingSecrets('reservations', new Set(REQUIRED.reservations)).missingOptional,
      ['MISTRAL_API_KEY'],
    );
  });

  it('require the password-reset token key on the gateway (reset email consumer)', () => {
    assert.ok(REQUIRED.main.includes('PASSWORD_RESET_TOKEN_KEY'));
    assert.ok(REQUIRED.main.includes('WEB_APP_URL'));
  });

  it('require Turnstile and Resend on the auth Worker', () => {
    assert.ok(REQUIRED.auth.includes('TURNSTILE_SECRET'));
    assert.ok(REQUIRED.auth.includes('RESEND_API_KEY'));
  });

  for (const [worker, configFile = 'wrangler.toml'] of Object.entries(CONFIG_FILES)) {
    it(`match the secrets documented in ${configFile}`, () => {
      const toml = readFileSync(path.join(API, configFile), 'utf8');
      const documented = headerSecrets(toml, 'Secrets (set once per env');
      assert.deepEqual([...documented].sort(), [...REQUIRED[worker]].sort());
      const documentedProduction = headerSecrets(toml, 'Production also');
      assert.deepEqual([...documentedProduction].sort(), [...PRODUCTION_REQUIRED[worker]].sort());
      const documentedOptional = headerSecrets(toml, 'Optional');
      assert.deepEqual([...documentedOptional].sort(), [...OPTIONAL[worker]].sort());
    });
  }
});

/** Producer binding names of `[[env.<envName>.queues.producers]]` tables. */
function producerBindings(toml, envName) {
  const names = new Set();
  let inProducers = false;
  for (const line of toml.split('\n')) {
    const header = /^\s*\[\[?([^\]]+)\]\]?/u.exec(line);
    if (header !== null) {
      inProducers = header[1].trim() === `env.${envName}.queues.producers`;
      continue;
    }
    const binding = inProducers ? /^\s*binding\s*=\s*"([^"]+)"/u.exec(line) : null;
    if (binding !== null) names.add(binding[1]);
  }
  return [...names].sort();
}

describe('queue bindings (issue #311)', () => {
  for (const [worker, configFile = 'wrangler.toml'] of Object.entries(CONFIG_FILES)) {
    it(`${configFile} documents every queue binding it declares`, () => {
      const toml = readFileSync(path.join(API, configFile), 'utf8');
      const documented = headerSecrets(toml, 'Queue bindings').sort();
      for (const env of ['staging', 'production']) {
        assert.deepEqual(producerBindings(toml, env), documented, `${worker} --env ${env}`);
      }
    });
  }

  it('checks the outbox kick queue of every env', () => {
    assert.ok(declaredQueues('staging').has('athlya-outbox-kick-staging'));
    assert.ok(declaredQueues('production').has('athlya-outbox-kick'));
  });
});

describe('missingSecrets', () => {
  it('reports required and production-only gaps separately', () => {
    const present = new Set(REQUIRED.billing.filter((name) => name !== 'BILLING_DB_URL'));
    const result = missingSecrets('billing', present);
    assert.deepEqual(result.missing, ['BILLING_DB_URL']);
    assert.deepEqual(result.missingProduction, PRODUCTION_REQUIRED.billing);
  });

  it('passes when every secret is present', () => {
    const present = new Set([...REQUIRED.auth, ...PRODUCTION_REQUIRED.auth]);
    assert.deepEqual(missingSecrets('auth', present), {
      missing: [],
      missingProduction: [],
      missingOptional: [],
    });
  });
});
