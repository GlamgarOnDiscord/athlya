/**
 * Unit tests for {@link generateNonce}.
 *
 * The nonce must be:
 *  - Non-empty and URL-safe (base64url alphabet, no padding).
 *  - Long enough to be unguessable — 128 random bits encode to 22
 *    characters in base64url without padding.
 *  - Fresh on every call; duplicates would break the per-request
 *    contract of Req 25.3.
 *
 * Task 10.1.
 */
import { describe, expect, it } from 'vitest';

import { generateNonce } from './nonce';

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/u;

describe('generateNonce', () => {
  it('produces a base64url string of at least 22 characters', () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(BASE64URL_RE);
    expect(nonce.length).toBeGreaterThanOrEqual(22);
  });

  it('never includes base64 padding', () => {
    const nonce = generateNonce();
    expect(nonce).not.toContain('=');
  });

  it('returns a fresh value on every call', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i += 1) {
      seen.add(generateNonce());
    }
    // 64 128-bit draws colliding is astronomically unlikely; if this fails
    // either the PRNG is broken or the encoder has been truncated.
    expect(seen.size).toBe(64);
  });
});
