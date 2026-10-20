/**
 * QR encoding for the web check-in page: the token becomes a square
 * matrix of modules drawn as one SVG path. Same encoder and settings as
 * the mobile check-in screen (`apps/mobile/features/checkin/qr-matrix.ts`),
 * so both apps show the same code for the same token.
 *
 * `qrcode-generator` is pure JS (MIT). Text is encoded in byte mode as
 * UTF-8; the check-in token is an ASCII JWT, so its bytes are its
 * characters.
 */
import qrcode from 'qrcode-generator';

/** Row-major modules; `true` is a dark module. Always square. */
export type QrMatrix = readonly (readonly boolean[])[];

/** Encodes `text` with the smallest QR version that fits it at level M. */
export function encodeQrMatrix(text: string): QrMatrix {
  const qr = qrcode(0, 'M');
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
 * SVG path (module units, viewBox `0 0 size size`) covering every dark
 * module, one rectangle per horizontal run.
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
