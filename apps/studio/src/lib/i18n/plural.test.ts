import { describe, expect, it } from 'vitest';

import { pluralKey } from './plural';

const KEYS = {
  one: 'studio.members.countOne',
  other: 'studio.members.countOther',
} as const;

describe('pluralKey', () => {
  it('uses the singular for 0 and 1 in French', () => {
    expect(pluralKey('fr', 0, KEYS)).toBe(KEYS.one);
    expect(pluralKey('fr', 1, KEYS)).toBe(KEYS.one);
    expect(pluralKey('fr', 2, KEYS)).toBe(KEYS.other);
  });

  it('uses the singular for 1 only in English', () => {
    expect(pluralKey('en', 0, KEYS)).toBe(KEYS.other);
    expect(pluralKey('en', 1, KEYS)).toBe(KEYS.one);
    expect(pluralKey('en', 14, KEYS)).toBe(KEYS.other);
  });
});
