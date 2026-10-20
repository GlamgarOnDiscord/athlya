import { describe, expect, it } from 'vitest';

import { DEFAULT_POST_AUTH_PATH, postAuthDestination } from './post-auth-destination';

describe('postAuthDestination', () => {
  it('lands on /classes without a destination parameter', () => {
    expect(DEFAULT_POST_AUTH_PATH).toBe('/classes');
    expect(postAuthDestination('')).toBe('/classes');
    expect(postAuthDestination('?lang=fr')).toBe('/classes');
  });

  it('follows a local next or redirect path, next first', () => {
    expect(postAuthDestination('?next=%2Fme%2Fprogression')).toBe('/me/progression');
    expect(postAuthDestination('?redirect=/me')).toBe('/me');
    expect(postAuthDestination('?redirect=/me&next=/classes?day=2')).toBe('/classes?day=2');
  });

  it.each([
    'https://evil.example/',
    '//evil.example/path',
    '/\\evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    '/\r/evil.example',
    'javascript:alert(1)',
    'me',
    '',
  ])('ignores %j and falls back to /classes', (value) => {
    expect(postAuthDestination(`?next=${encodeURIComponent(value)}`)).toBe('/classes');
  });
});
