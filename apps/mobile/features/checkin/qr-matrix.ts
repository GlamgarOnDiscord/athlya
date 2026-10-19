/**
 * QR encoding for the check-in screen (task 11.9): the token becomes a
 * square matrix of modules, drawn by `components/QrCode.tsx` as a single
 * SVG path with `react-native-svg`.
 *
 * The encoder is `qrcode-generator` (pure JS, no dependencies). Text is
 * encoded in byte mode as UTF-8; the check-in token is an ASCII JWT, so
 * its bytes are its characters.
 */
import qrcode from 'qrcode-generator';

export type ErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

/** Row-major modules; `true` is a dark module. Always square. */
export type QrMatrix = readonly (readonly boolean[])[];

/**
 * Encodes `text` with the smallest QR version that fits it at the given
 * error-correction level. Throws when the text does not fit any version.
 */
export function encodeQrMatrix(text: string, ecl: ErrorCorrectionLevel = 'M'): QrMatrix {
  const qr = qrcode(0, ecl);
  // The encoder maps each UTF-16 unit to one byte (`code & 0xff`), so the
  // UTF-8 bytes go in as a binary string to keep non-ASCII text intact.
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  qr.addData(binary, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  const rows: boolean[][] = [];
  for (let row = 0; row < size; row += 1) {
    const cells: boolean[] = [];
    for (let col = 0; col < size; col += 1) cells.push(qr.isDark(row, col));
    rows.push(cells);
  }
  return rows;
}

/**
 * SVG path (in module units, viewBox `0 0 size size`) covering every dark
 * module. Horizontal runs of dark modules are merged into one rectangle
 * each, which keeps the path short for a ~600-character token.
 */
export function qrMatrixPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  matrix.forEach((cells, row) => {
    let col = 0;
    while (col < cells.length) {
      if (cells[col] !== true) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < cells.length && cells[col] === true) col += 1;
      parts.push(
        `M${String(start)} ${String(row)}h${String(col - start)}v1h-${String(col - start)}z`,
      );
    }
  });
  return parts.join('');
}
