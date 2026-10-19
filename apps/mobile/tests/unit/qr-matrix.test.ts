import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';

import { encodeQrMatrix, qrMatrixPath, type QrMatrix } from '../../features/checkin/qr-matrix';

const QUIET_ZONE = 4;
const PIXELS_PER_MODULE = 4;

/**
 * Rasterises the path `QrCode` draws (module units) on a light background
 * with a quiet zone, the way the check-in screen shows it, into RGBA
 * pixels a QR decoder can read.
 */
function rasterise(path: string, count: number) {
  const modules = count + 2 * QUIET_ZONE;
  const width = modules * PIXELS_PER_MODULE;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  const runs = path.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g);
  let drawn = 0;
  for (const [segment, x, y, w, back] of runs) {
    expect(back).toBe(w);
    drawn += segment.length;
    for (let col = Number(x); col < Number(x) + Number(w); col += 1) {
      for (let py = 0; py < PIXELS_PER_MODULE; py += 1) {
        for (let px = 0; px < PIXELS_PER_MODULE; px += 1) {
          const row = (Number(y) + QUIET_ZONE) * PIXELS_PER_MODULE + py;
          const column = (col + QUIET_ZONE) * PIXELS_PER_MODULE + px;
          const offset = (row * width + column) * 4;
          pixels[offset] = 0;
          pixels[offset + 1] = 0;
          pixels[offset + 2] = 0;
        }
      }
    }
  }
  // The path is made of rectangles only: nothing is left unparsed.
  expect(drawn).toBe(path.length);
  return { pixels, width };
}

function decodeRendered(text: string) {
  const matrix = encodeQrMatrix(text, 'M');
  const { pixels, width } = rasterise(qrMatrixPath(matrix), matrix.length);
  return { matrix, result: jsQR(pixels, width, width) };
}

function darkCells(matrix: QrMatrix): number {
  return matrix.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
}

/** Shape of a real check-in token: an RS256 JWT of roughly 600 characters. */
const CHECKIN_TOKEN = [
  'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImF0aGx5YS0yMDI2LTEwIn0',
  'eyJzdWIiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJzdHVkaW8iOiIyMjIyMjIyMi0yMjIyLTQyMjItODIyMi0yMjIyMjIyMjIyMjIiLCJqdGkiOiJjY2NjY2NjYy1jY2NjLTRjY2MtOGNjYy1jY2NjY2NjY2NjYzMiLCJwdXJwb3NlIjoiY2hlY2tpbiIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAwMTIwfQ',
  'Q2hlY2staW4gdG9rZW4gc2lnbmF0dXJlIHBsYWNlaG9sZGVyIGZvciB0ZXN0cyBvbmx5LCBub3QgYSByZWFsIFJTMjU2IHNpZ25hdHVyZSBidXQgb2YgYSBzaW1pbGFyIGxlbmd0aCB0byBleGVyY2lzZSBhIGxhcmdlIFFSIHZlcnNpb24gYXQgbGV2ZWwgTS4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4',
].join('.');

describe('encodeQrMatrix + qrMatrixPath', () => {
  it('renders a check-in token that decodes back to the token', () => {
    const { matrix, result } = decodeRendered(CHECKIN_TOKEN);

    expect(result?.data).toBe(CHECKIN_TOKEN);
    expect(matrix.every((row) => row.length === matrix.length)).toBe(true);
  });

  it('renders a short value that decodes back to it', () => {
    expect(decodeRendered('athlya').result?.data).toBe('athlya');
  });

  it('encodes non-ASCII text as UTF-8 bytes', () => {
    const text = 'Séance café ✓';
    const { result } = decodeRendered(text);

    expect(result?.binaryData).toEqual(Array.from(new TextEncoder().encode(text)));
  });

  it('picks a larger version for longer values and a higher error-correction level', () => {
    const short = encodeQrMatrix('athlya', 'M');
    expect(short.length).toBe(21);
    expect(encodeQrMatrix(CHECKIN_TOKEN, 'M').length).toBeGreaterThan(short.length);
    expect(encodeQrMatrix(CHECKIN_TOKEN, 'H').length).toBeGreaterThan(
      encodeQrMatrix(CHECKIN_TOKEN, 'M').length,
    );
  });

  it('covers exactly the dark modules with one rectangle per horizontal run', () => {
    const matrix = encodeQrMatrix(CHECKIN_TOKEN, 'M');
    const covered = [...qrMatrixPath(matrix).matchAll(/h(\d+)v1/g)].reduce(
      (sum, [, w]) => sum + Number(w),
      0,
    );

    expect(covered).toBe(darkCells(matrix));
    expect(qrMatrixPath([[false, true, true, false, true]])).toBe('M1 0h2v1h-2zM4 0h1v1h-1z');
  });
});
