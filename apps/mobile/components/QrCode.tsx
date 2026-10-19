import { useMemo } from 'react';
import Svg, { Path, Rect } from 'react-native-svg';

import {
  encodeQrMatrix,
  qrMatrixPath,
  type ErrorCorrectionLevel,
} from '../features/checkin/qr-matrix';

export interface QrCodeProps {
  readonly value: string;
  /** Width and height in points. */
  readonly size: number;
  /** Dark modules. */
  readonly color: string;
  readonly backgroundColor: string;
  readonly ecl?: ErrorCorrectionLevel;
}

/**
 * QR code drawn with `react-native-svg`: one background square and one
 * path for every dark module, scaled from module units to `size`. There
 * is no built-in quiet zone; the caller pads it with the background
 * colour. All dark modules share one path so that no anti-aliasing seam
 * shows between neighbouring modules.
 *
 * Hidden from assistive technologies: the caller labels the code.
 */
export function QrCode({ value, size, color, backgroundColor, ecl = 'M' }: QrCodeProps) {
  const { count, path } = useMemo(() => {
    const matrix = encodeQrMatrix(value, ecl);
    return { count: matrix.length, path: qrMatrixPath(matrix) };
  }, [value, ecl]);

  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${String(count)} ${String(count)}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Rect x={0} y={0} width={count} height={count} fill={backgroundColor} />
      <Path d={path} fill={color} />
    </Svg>
  );
}
