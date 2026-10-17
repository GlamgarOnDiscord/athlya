import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { validatePreviewJwtConfig } from '../validate-preview-jwt.mjs';

function keyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  });
}

function jwksFor(publicKey, kid) {
  const jwk = createPublicKey(publicKey).export({ format: 'jwk' });
  return JSON.stringify({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] });
}

const KID = 'preview-2026-10';
const PAIR = keyPair();
const OTHER = keyPair();

function validConfig(overrides = {}) {
  return {
    jwksUrl: 'https://keys.athlya.test/preview/jwks.json',
    kid: KID,
    privateKeyPem: PAIR.privateKey,
    publicKeyPem: PAIR.publicKey,
    jwksJson: jwksFor(PAIR.publicKey, KID),
    ...overrides,
  };
}

describe('validatePreviewJwtConfig', () => {
  it('accepts a dedicated, consistent preview pair', () => {
    assert.deepEqual(validatePreviewJwtConfig(validConfig()), []);
  });

  it('rejects a kid that is not a preview kid', () => {
    const errors = validatePreviewJwtConfig(
      validConfig({ kid: 'staging-1', jwksJson: jwksFor(PAIR.publicKey, 'staging-1') }),
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /must start with "preview-"/u);
  });

  it('rejects a non-https or malformed JWKS URL', () => {
    assert.match(validatePreviewJwtConfig(validConfig({ jwksUrl: 'nope' }))[0], /absolute URL/u);
    assert.match(
      validatePreviewJwtConfig(validConfig({ jwksUrl: 'http://keys.athlya.test/jwks.json' }))[0],
      /https/u,
    );
  });

  it('rejects escaped single-line PEMs', () => {
    const escaped = PAIR.privateKey.replace(/\n/gu, '\\n');
    const errors = validatePreviewJwtConfig(validConfig({ privateKeyPem: escaped }));
    assert.match(errors[0], /literal "\\n" escapes/u);
  });

  it('rejects PEMs that do not parse or have the wrong block', () => {
    const label = 'PRIVATE ' + 'KEY-----';
    const garbled = `-----BEGIN ${label}\nAAAA\n-----END ${label}\n`;
    assert.match(
      validatePreviewJwtConfig(validConfig({ privateKeyPem: garbled }))[0],
      /cannot be parsed/u,
    );
    assert.match(
      validatePreviewJwtConfig(validConfig({ publicKeyPem: PAIR.privateKey }))[0],
      /"PUBLIC KEY" PEM block/u,
    );
  });

  it('rejects a public key from another pair', () => {
    const errors = validatePreviewJwtConfig(validConfig({ publicKeyPem: OTHER.publicKey }));
    assert.ok(errors.some((e) => /does not match PREVIEW_JWT_PRIVATE_KEY_PEM/u.test(e)));
  });

  it('rejects a JWKS that is malformed, misses the kid or holds another key', () => {
    assert.match(validatePreviewJwtConfig(validConfig({ jwksJson: '{' }))[0], /valid JSON/u);
    assert.match(validatePreviewJwtConfig(validConfig({ jwksJson: '{}' }))[0], /"keys" array/u);
    assert.match(
      validatePreviewJwtConfig(validConfig({ jwksJson: jwksFor(PAIR.publicKey, 'preview-x') }))[0],
      /does not list PREVIEW_JWT_KID/u,
    );
    assert.match(
      validatePreviewJwtConfig(validConfig({ jwksJson: jwksFor(OTHER.publicKey, KID) }))[0],
      /does not match the public key/u,
    );
  });

  it('rejects a JWKS that carries private key members', () => {
    const jwk = createPublicKey(PAIR.privateKey).export({ format: 'jwk' });
    const leaked = JSON.stringify({ keys: [{ ...jwk, d: 'secret', kid: KID }] });
    assert.match(
      validatePreviewJwtConfig(validConfig({ jwksJson: leaked }))[0],
      /only hold public keys/u,
    );
  });

  it('reports every empty value', () => {
    assert.equal(validatePreviewJwtConfig({}).length, 5);
  });
});
