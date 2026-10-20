import { describe, expect, it } from 'vitest';

import { createTranslator } from '../../lib/i18n/t';

import { formatDuration } from './format-duration';

const fr = createTranslator('fr');
const en = createTranslator('en');

describe('formatDuration', () => {
  it('reads minutes, hours with padded minutes, then days', () => {
    expect(formatDuration(45, fr)).toBe('45 min');
    expect(formatDuration(125, fr)).toBe('2 h 05');
    expect(formatDuration(125, en)).toBe('2h 05');
    expect(formatDuration(3 * 24 * 60 + 10, fr)).toBe('3 j');
    expect(formatDuration(3 * 24 * 60 + 10, en)).toBe('3 d');
  });
});
