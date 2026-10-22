import { describe, expect, it } from 'vitest';

import { LOGO_MAX_BYTES, logoFileProblem } from './LogoEditor';

describe('logoFileProblem', () => {
  it('accepts PNG, JPEG and WebP up to the cap', () => {
    expect(logoFileProblem({ type: 'image/png', size: LOGO_MAX_BYTES })).toBeNull();
    expect(logoFileProblem({ type: 'image/jpeg', size: 10 })).toBeNull();
    expect(logoFileProblem({ type: 'image/webp', size: 10 })).toBeNull();
  });

  it('refuses SVG and oversized files before the upload', () => {
    expect(logoFileProblem({ type: 'image/svg+xml', size: 10 })).toBe('invalidType');
    expect(logoFileProblem({ type: 'image/png', size: LOGO_MAX_BYTES + 1 })).toBe('tooLarge');
  });
});
