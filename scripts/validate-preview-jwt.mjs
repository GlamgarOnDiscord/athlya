#!/usr/bin/env node
/**
 * Validate the preview JWT secrets before `.github/workflows/preview.yml`
 * provisions anything (issue #611).
 *
 * Reads PREVIEW_JWT_JWKS_URL, PREVIEW_JWT_KID, PREVIEW_JWT_PRIVATE_KEY_PEM,
 * PREVIEW_JWT_PUBLIC_KEY_PEM and PREVIEW_JWKS_JSON from the environment and
 * exits 1 with one `::error::` line per problem. Values are never printed.
 *
 * Checks:
 *   - the JWKS URL is an absolute https URL;
 *   - the kid starts with `preview-`, so the pair was generated for
 *     previews (previews run PR code: they must never hold the staging
 *     or production signing key);
 *   - both PEMs are real multi-line PKCS#8 / SPKI RSA keys (a value with
 *     literal `\n` escapes is rejected) and form one pair;
 *   - the JWKS is a public-only key set that lists the kid with the same
 *     RSA modulus and exponent.
 */

import { createPrivateKey, createPublicKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const PREVIEW_KID_PREFIX = 'preview-';

const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

function rsaPublicJwk(keyObject) {
  const jwk = keyObject.export({ format: 'jwk' });
  return { n: jwk.n, e: jwk.e };
}

function checkPem(pem, label, header) {
  if (pem.includes('\\n')) {
    return `${label} contains literal "\\n" escapes; store the multi-line PEM file content`;
  }
  if (!pem.trimStart().startsWith(`-----BEGIN ${header}-----`)) {
    return `${label} must be a "${header}" PEM block`;
  }
  return null;
}

/**
 * @param {{ jwksUrl?: string, kid?: string, privateKeyPem?: string,
 *           publicKeyPem?: string, jwksJson?: string }} config
 * @returns {string[]} problems; empty when the configuration is valid
 */
export function validatePreviewJwtConfig(config) {
  const errors = [];
  const { jwksUrl = '', kid = '', privateKeyPem = '', publicKeyPem = '', jwksJson = '' } = config;

  let url = null;
  try {
    url = new URL(jwksUrl);
  } catch {
    errors.push('PREVIEW_JWT_JWKS_URL is not an absolute URL');
  }
  if (url !== null && url.protocol !== 'https:') {
    errors.push('PREVIEW_JWT_JWKS_URL must use https');
  }

  if (!/^[A-Za-z0-9._-]+$/u.test(kid)) {
    errors.push('PREVIEW_JWT_KID must be a non-empty [A-Za-z0-9._-] identifier');
  } else if (!kid.startsWith(PREVIEW_KID_PREFIX)) {
    errors.push(
      `PREVIEW_JWT_KID must start with "${PREVIEW_KID_PREFIX}": use a dedicated preview key pair, never the staging one`,
    );
  }

  let derivedPublic = null;
  const privateProblem = checkPem(privateKeyPem, 'PREVIEW_JWT_PRIVATE_KEY_PEM', 'PRIVATE KEY');
  if (privateProblem !== null) {
    errors.push(privateProblem);
  } else {
    try {
      const key = createPrivateKey(privateKeyPem);
      if (key.asymmetricKeyType !== 'rsa') {
        errors.push('PREVIEW_JWT_PRIVATE_KEY_PEM must be an RSA key (RS256)');
      } else {
        derivedPublic = rsaPublicJwk(createPublicKey(key));
      }
    } catch {
      errors.push('PREVIEW_JWT_PRIVATE_KEY_PEM cannot be parsed as a PKCS#8 key');
    }
  }

  let publicJwk = null;
  const publicProblem = checkPem(publicKeyPem, 'PREVIEW_JWT_PUBLIC_KEY_PEM', 'PUBLIC KEY');
  if (publicProblem !== null) {
    errors.push(publicProblem);
  } else {
    try {
      const key = createPublicKey(publicKeyPem);
      if (key.asymmetricKeyType !== 'rsa') {
        errors.push('PREVIEW_JWT_PUBLIC_KEY_PEM must be an RSA key (RS256)');
      } else {
        publicJwk = rsaPublicJwk(key);
      }
    } catch {
      errors.push('PREVIEW_JWT_PUBLIC_KEY_PEM cannot be parsed as an SPKI key');
    }
  }

  if (
    derivedPublic !== null &&
    publicJwk !== null &&
    (derivedPublic.n !== publicJwk.n || derivedPublic.e !== publicJwk.e)
  ) {
    errors.push('PREVIEW_JWT_PUBLIC_KEY_PEM does not match PREVIEW_JWT_PRIVATE_KEY_PEM');
  }

  let jwks = null;
  try {
    jwks = JSON.parse(jwksJson);
  } catch {
    errors.push('PREVIEW_JWKS_JSON is not valid JSON');
  }
  if (jwks !== null) {
    const keys = Array.isArray(jwks?.keys) ? jwks.keys : null;
    if (keys === null) {
      errors.push('PREVIEW_JWKS_JSON must be an object with a "keys" array');
    } else {
      if (keys.some((k) => PRIVATE_JWK_MEMBERS.some((m) => k !== null && m in Object(k)))) {
        errors.push('PREVIEW_JWKS_JSON must only hold public keys');
      }
      const entry = keys.find((k) => k?.kid === kid);
      if (entry === undefined) {
        errors.push('PREVIEW_JWKS_JSON does not list PREVIEW_JWT_KID');
      } else if (entry.kty !== 'RSA') {
        errors.push('PREVIEW_JWKS_JSON entry for PREVIEW_JWT_KID must have kty "RSA"');
      } else if (entry.alg !== undefined && entry.alg !== 'RS256') {
        errors.push('PREVIEW_JWKS_JSON entry for PREVIEW_JWT_KID must use alg "RS256"');
      } else if (publicJwk !== null && (entry.n !== publicJwk.n || entry.e !== publicJwk.e)) {
        errors.push('PREVIEW_JWKS_JSON entry for PREVIEW_JWT_KID does not match the public key');
      }
    }
  }

  return errors;
}

function main() {
  const errors = validatePreviewJwtConfig({
    jwksUrl: process.env.PREVIEW_JWT_JWKS_URL,
    kid: process.env.PREVIEW_JWT_KID,
    privateKeyPem: process.env.PREVIEW_JWT_PRIVATE_KEY_PEM,
    publicKeyPem: process.env.PREVIEW_JWT_PUBLIC_KEY_PEM,
    jwksJson: process.env.PREVIEW_JWKS_JSON,
  });
  for (const error of errors) console.error(`::error::${error}`);
  if (errors.length > 0) process.exit(1);
  console.log('[validate-preview-jwt] preview JWT secrets are valid');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
