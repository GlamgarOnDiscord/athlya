import { describe, expect, it } from 'vitest';

import { safeJsonLd } from './JsonLd';

describe('safeJsonLd', () => {
  it('serializes plain data as JSON', () => {
    const result = safeJsonLd({ '@type': 'Organization', name: 'Athlya' });
    expect(JSON.parse(result)).toEqual({ '@type': 'Organization', name: 'Athlya' });
  });

  it('escapes < to prevent </script> breakout', () => {
    const result = safeJsonLd({ x: '</script><script>alert(1)</script>' });
    expect(result).not.toContain('</script>');
    expect(result).toContain('\\u003c');
  });

  it('escapes > so injected markup cannot close the tag', () => {
    const result = safeJsonLd({ x: '>' });
    expect(result).not.toContain('>');
    expect(result).toContain('\\u003e');
  });

  it('escapes & to prevent entity injection', () => {
    const result = safeJsonLd({ x: '&amp;' });
    expect(result).not.toContain('&');
    expect(result).toContain('\\u0026');
  });

  it('produces valid JSON after escaping', () => {
    const payload = { x: '</script>&<b>' };
    expect(() => JSON.parse(safeJsonLd(payload))).not.toThrow();
  });
});
