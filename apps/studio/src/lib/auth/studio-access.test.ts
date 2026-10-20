import { describe, expect, it } from 'vitest';

import { canUseStudio } from './studio-access';

describe('canUseStudio', () => {
  it('lets administrators and coaches into the console and keeps members out', () => {
    expect(canUseStudio('admin')).toBe(true);
    expect(canUseStudio('coach')).toBe(true);
    expect(canUseStudio('member')).toBe(false);
  });
});
