import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('AthlyaLogo copies', () => {
  it('stays identical between the web and studio apps', () => {
    const read = (rel: string): string =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    expect(read('./AthlyaLogo.tsx')).toBe(read('../../../studio/src/components/AthlyaLogo.tsx'));
  });
});
