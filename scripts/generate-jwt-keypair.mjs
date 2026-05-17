/**
 * One-shot JWT keypair generator for Athlya local dev.
 *
 * Produces:
 *   - A fresh RSA 2048 keypair (SPKI + PKCS#8 PEM format).
 *   - A ready-to-serve JWKS JSON document with the public key alone.
 *
 * Writes three files under `scripts/dev-secrets/`:
 *   - jwt-private.pem   — PKCS#8 private key (NEVER commit)
 *   - jwt-public.pem    — SPKI public key (safe to share)
 *   - jwks.json         — JWKS with `kid` + `alg=RS256` + `use=sig`
 *
 * Also prints the escaped multi-line values you must paste into
 * `packages/api/.dev.vars` (Wrangler reads `KEY="..."` with literal
 * `\n` sequences — the output below already escapes them).
 *
 * Usage:
 *   node scripts/generate-jwt-keypair.mjs
 *
 * Regenerating keys invalidates every existing access token. Do that
 * at most once per dev environment, or whenever a key is suspected
 * leaked.
 */

import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(SCRIPT_DIR, 'dev-secrets');

function main() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  });

  const kid = `dev-${Date.now().toString(36)}`;

  // Export the public key as a JWK so the Worker can serve it. We
  // use the stdlib `createPublicKey(pem).export({ format: 'jwk' })`
  // which is sync and avoids pulling `jose` into this bootstrap
  // script (jose's ESM entrypoint is heavier than we need here).
  const publicKeyObject = createPublicKey(publicKey);
  const jwk = publicKeyObject.export({ format: 'jwk' });
  const jwks = {
    keys: [
      {
        ...jwk,
        kid,
        alg: 'RS256',
        use: 'sig',
      },
    ],
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'jwt-private.pem'), privateKey, 'utf8');
  writeFileSync(resolve(OUT_DIR, 'jwt-public.pem'), publicKey, 'utf8');
  writeFileSync(resolve(OUT_DIR, 'jwks.json'), JSON.stringify(jwks, null, 2) + '\n', 'utf8');

  // eslint-disable-next-line no-console
  console.log(`[generate-jwt-keypair] Wrote ${OUT_DIR}/`);
  // eslint-disable-next-line no-console
  console.log(`  kid = ${kid}`);
  console.log('');
  console.log('Paste these into packages/api/.dev.vars:');
  console.log('');
  console.log(`JWT_KID=${kid}`);
  console.log(`JWT_PRIVATE_KEY_PEM="${privateKey.replace(/\n/g, '\\n')}"`);
  console.log(`JWT_PUBLIC_KEY_PEM="${publicKey.replace(/\n/g, '\\n')}"`);
}

main();
