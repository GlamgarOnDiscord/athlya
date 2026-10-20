import { describe, expect, it } from 'vitest';

import { toCsv } from './csv';

describe('toCsv', () => {
  it('joins rows with CRLF and quotes cells that need it', () => {
    expect(
      toCsv(
        ['Nom', 'E-mail'],
        [
          ['Camille Durand', 'camille.durand@example.com'],
          ['Durand, "Cam"', 'x@example.com'],
        ],
      ),
    ).toBe(
      'Nom,E-mail\r\nCamille Durand,camille.durand@example.com\r\n"Durand, ""Cam""",x@example.com',
    );
  });

  it('neutralises cells a spreadsheet would run as a formula', () => {
    expect(toCsv(['a'], [['=HYPERLINK("x")'], ['+1'], ['-2'], ['@SUM(A1)']])).toBe(
      'a\r\n"\'=HYPERLINK(""x"")"\r\n\'+1\r\n\'-2\r\n\'@SUM(A1)',
    );
  });
});
