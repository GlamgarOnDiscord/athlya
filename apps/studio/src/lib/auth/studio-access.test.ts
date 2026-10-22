import { describe, expect, it } from 'vitest';

import { canUseStudio } from './studio-access';

describe('canUseStudio', () => {
  it('lets every staff role into the console and keeps members out', () => {
    expect(canUseStudio('admin')).toBe(true);
    expect(canUseStudio('manager')).toBe(true);
    expect(canUseStudio('accueil')).toBe(true);
    expect(canUseStudio('coach')).toBe(true);
    expect(canUseStudio('member')).toBe(false);
  });
});
