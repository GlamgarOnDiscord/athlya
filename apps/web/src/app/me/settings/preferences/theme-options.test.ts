import { describe, expect, it } from 'vitest';

import { selectedTheme } from './theme-options';

describe('selectedTheme', () => {
  it.each(['light', 'dark', 'system'] as const)('selects %s', (theme) => {
    expect(selectedTheme(theme)).toBe(theme);
  });

  it('selects nothing before the theme is read', () => {
    expect(selectedTheme(undefined)).toBeNull();
  });

  it('selects nothing for an unknown stored value', () => {
    expect(selectedTheme('sepia')).toBeNull();
  });
});
