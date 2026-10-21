import { describe, expect, it } from 'vitest';

import { createTranslator } from '../../../lib/i18n/t';

import { formatEuros, formatPlanPrice, planName } from './plan-display';

const fr = createTranslator('fr');
const en = createTranslator('en');

/** Intl separates "49" and "€" with a narrow no-break space in French. */
const normalizeSpaces = (s: string): string => s.replace(/[  ]/gu, ' ');

describe('formatEuros', () => {
  it('puts the symbol where each locale expects it', () => {
    expect(normalizeSpaces(formatEuros(49, 'fr'))).toBe('49 €');
    expect(formatEuros(49, 'en')).toBe('€49');
  });

  it('keeps cents only when there are some', () => {
    expect(normalizeSpaces(formatEuros(0, 'fr'))).toBe('0 €');
    expect(normalizeSpaces(formatEuros(12.5, 'fr'))).toBe('12,50 €');
    expect(formatEuros(12.5, 'en')).toBe('€12.50');
  });
});

describe('formatPlanPrice', () => {
  it('reads a monthly price in French', () => {
    expect(normalizeSpaces(formatPlanPrice('free', 'fr', fr))).toBe('0 € / mois');
    expect(normalizeSpaces(formatPlanPrice('pro', 'fr', fr))).toBe('49 € / mois');
  });

  it('reads a monthly price in English', () => {
    expect(formatPlanPrice('free', 'en', en)).toBe('€0 / month');
    expect(formatPlanPrice('pro', 'en', en)).toBe('€49 / month');
  });
});

describe('planName', () => {
  it('localizes the free plan and keeps Pro as is', () => {
    expect(planName('free', fr)).toBe('Gratuit');
    expect(planName('free', en)).toBe('Free');
    expect(planName('pro', fr)).toBe('Pro');
    expect(planName('pro', en)).toBe('Pro');
  });
});
