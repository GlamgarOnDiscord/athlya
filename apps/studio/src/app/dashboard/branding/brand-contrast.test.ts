import { describe, expect, it } from 'vitest';

import { formatRatio, readBrandContrast } from './brand-contrast';

describe('readBrandContrast', () => {
  it('pairs a dark color with white text that meets AA', () => {
    const reading = readBrandContrast('#0f766e');
    expect(reading).toMatchObject({ color: '#0F766E', onPrimary: '#FFFFFF', meetsAa: true });
    expect(reading?.ratio).toBeGreaterThanOrEqual(4.5);
    expect(reading?.onLight.use).toBe('text');
  });

  it('warns that a light color cannot carry text on a light surface', () => {
    const reading = readBrandContrast('#D7FF3A');
    expect(reading?.onPrimary).toBe('#000000');
    expect(reading?.onLight.use).toBe('fill');
    expect(reading?.onDark.use).toBe('text');
  });

  it('flags a mid tone as icons and borders only on white', () => {
    expect(readBrandContrast('#949494')?.onLight.use).toBe('graphics');
  });

  it('returns null for anything but #RRGGBB', () => {
    expect(readBrandContrast('#fff')).toBeNull();
    expect(readBrandContrast('teal')).toBeNull();
  });
});

describe('formatRatio', () => {
  it('rounds down to one decimal so a passing label never overstates', () => {
    expect(formatRatio(4.58)).toBe('4.5:1');
    expect(formatRatio(21)).toBe('21.0:1');
  });
});
