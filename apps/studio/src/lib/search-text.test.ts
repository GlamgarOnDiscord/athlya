import { describe, expect, it } from 'vitest';

import { foldText, matchesQuery } from './search-text';

describe('foldText and matchesQuery', () => {
  it('ignores case and accents', () => {
    expect(foldText('  Léa Fontaine ')).toBe('lea fontaine');
    expect(matchesQuery('LEA', 'Léa Fontaine')).toBe(true);
    expect(matchesQuery('mobilite', 'Mobilité')).toBe(true);
  });

  it('matches any field and accepts an empty query', () => {
    expect(matchesQuery('example.com', 'Camille Durand', 'camille.durand@example.com')).toBe(true);
    expect(matchesQuery('zumba', 'Camille Durand')).toBe(false);
    expect(matchesQuery('  ', 'anything')).toBe(true);
  });
});
