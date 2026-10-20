/**
 * Frame decoder selection and the canvas + jsqr fallback used by
 * browsers without a native QR `BarcodeDetector`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { canvasDecoder, createFrameDecoder } from './qr-frame-decoder';

const jsQRMock = vi.hoisted(() => vi.fn());
vi.mock('jsqr', () => ({ default: jsQRMock }));

function fakeVideo(width: number, height: number): HTMLVideoElement {
  return { videoWidth: width, videoHeight: height } as HTMLVideoElement;
}

function fakeCanvas(): { canvas: HTMLCanvasElement; drawImage: ReturnType<typeof vi.fn> } {
  const drawImage = vi.fn();
  const context = {
    drawImage,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
    }),
  };
  const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
  return { canvas, drawImage };
}

afterEach(() => {
  jsQRMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('canvasDecoder', () => {
  it('returns null before the video has a frame', async () => {
    const { canvas } = fakeCanvas();
    const decode = canvasDecoder(() => canvas);
    expect(await decode(fakeVideo(0, 0))).toBeNull();
    expect(jsQRMock).not.toHaveBeenCalled();
  });

  it('downscales a large frame before decoding and returns the payload', async () => {
    jsQRMock.mockReturnValue({ data: 'eyJ.token' });
    const { canvas, drawImage } = fakeCanvas();
    const decode = canvasDecoder(() => canvas);
    expect(await decode(fakeVideo(1920, 1080))).toBe('eyJ.token');
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 640, 360);
    expect(jsQRMock).toHaveBeenCalledWith(expect.any(Uint8ClampedArray), 640, 360, {
      inversionAttempts: 'dontInvert',
    });
  });

  it('returns null when no QR code is in the frame', async () => {
    jsQRMock.mockReturnValue(null);
    const { canvas } = fakeCanvas();
    expect(await canvasDecoder(() => canvas)(fakeVideo(640, 480))).toBeNull();
  });
});

describe('createFrameDecoder', () => {
  it('uses the native detector when it reads QR codes', async () => {
    const detect = vi.fn().mockResolvedValue([{ rawValue: 'native-token' }]);
    class FakeDetector {
      public static getSupportedFormats(): Promise<string[]> {
        return Promise.resolve(['qr_code', 'ean_13']);
      }
      public detect = detect;
    }
    vi.stubGlobal('BarcodeDetector', FakeDetector);
    const decode = await createFrameDecoder();
    expect(await decode(fakeVideo(640, 480))).toBe('native-token');
    expect(jsQRMock).not.toHaveBeenCalled();
  });

  it('falls back to jsqr when the native detector cannot read QR codes', async () => {
    class FakeDetector {
      public static getSupportedFormats(): Promise<string[]> {
        return Promise.resolve(['ean_13']);
      }
      public detect = vi.fn();
    }
    vi.stubGlobal('BarcodeDetector', FakeDetector);
    const { canvas } = fakeCanvas();
    vi.spyOn(document, 'createElement').mockReturnValue(canvas);
    jsQRMock.mockReturnValue({ data: 'js-token' });
    const decode = await createFrameDecoder();
    expect(await decode(fakeVideo(640, 480))).toBe('js-token');
  });
});
