/**
 * Unit tests for `@athlya/auth/password`.
 *
 * These cover the three guarantees advertised by the module:
 *   1. `hash` produces a valid bcrypt string at cost 12 (Req 1.1).
 *   2. `verify(password, hash(password))` is `true` and
 *      `verify(wrongPassword, hash(password))` is `false` (round-trip).
 *   3. Both functions reject an empty password with
 *      {@link EmptyPasswordError}.
 *
 * Related requirements: 1.1.
 */

import { describe, expect, it } from 'vitest';

import { BCRYPT_COST, EmptyPasswordError, hash, verify } from '../password.js';

const BCRYPT_HASH_REGEX = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/;

describe('password.hash', () => {
  it('produces a bcrypt-formatted string', async () => {
    const result = await hash('correct horse battery staple');
    expect(result).toMatch(BCRYPT_HASH_REGEX);
    expect(result).toHaveLength(60);
  });

  it('embeds the configured cost factor (>= 12)', async () => {
    const result = await hash('s3cret!');
    const match = BCRYPT_HASH_REGEX.exec(result);
    expect(match).not.toBeNull();
    const cost = Number.parseInt(match?.[1] ?? '0', 10);
    expect(cost).toBe(BCRYPT_COST);
    expect(cost).toBeGreaterThanOrEqual(12);
  });

  it('produces a different hash for the same input (salt is random)', async () => {
    const a = await hash('same-input');
    const b = await hash('same-input');
    expect(a).not.toBe(b);
  });

  it('rejects an empty password with EmptyPasswordError', async () => {
    await expect(hash('')).rejects.toBeInstanceOf(EmptyPasswordError);
  });
});

describe('password.verify', () => {
  it('returns true for the hashed password (round-trip)', async () => {
    const password = 'round-trip!';
    const digest = await hash(password);
    expect(await verify(password, digest)).toBe(true);
  });

  it('returns false for a wrong password', async () => {
    const digest = await hash('original');
    expect(await verify('tampered', digest)).toBe(false);
  });

  it('returns false for a malformed hash string', async () => {
    expect(await verify('anything', 'not-a-bcrypt-hash')).toBe(false);
  });

  it('rejects an empty password with EmptyPasswordError', async () => {
    const digest = await hash('x');
    await expect(verify('', digest)).rejects.toBeInstanceOf(EmptyPasswordError);
  });
});
