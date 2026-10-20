/**
 * Decodes a QR code from the kiosk's live video, one frame at a time.
 *
 * The native `BarcodeDetector` is used when the browser ships it with
 * `qr_code` support (Chrome on Android, ChromeOS, recent macOS
 * Chrome). Everywhere else (Firefox, Safari, most desktop Chrome
 * builds) the frame is drawn on a canvas and handed to `jsqr`, a
 * pure-JS decoder (Apache-2.0), so the kiosk scans on every browser
 * that can open a camera.
 */
import jsQR from 'jsqr';

/** Returns the QR payload found in the frame, or `null` when there is none. */
export type FrameDecoder = (video: HTMLVideoElement) => Promise<string | null>;

interface NativeBarcodeDetector {
  detect(source: HTMLVideoElement): Promise<ReadonlyArray<{ readonly rawValue: string }>>;
}

interface NativeBarcodeDetectorClass {
  new (options: { formats: string[] }): NativeBarcodeDetector;
  getSupportedFormats?: () => Promise<string[]>;
}

/** Longest side, in pixels, of the frame handed to the JS decoder. */
const MAX_DECODE_SIDE = 640;

function nativeDetectorClass(): NativeBarcodeDetectorClass | null {
  if (typeof window === 'undefined') return null;
  const ctor = (window as unknown as { BarcodeDetector?: NativeBarcodeDetectorClass })
    .BarcodeDetector;
  return ctor ?? null;
}

async function supportsNativeQr(ctor: NativeBarcodeDetectorClass): Promise<boolean> {
  if (ctor.getSupportedFormats === undefined) return true;
  try {
    return (await ctor.getSupportedFormats()).includes('qr_code');
  } catch {
    return false;
  }
}

function nativeDecoder(ctor: NativeBarcodeDetectorClass): FrameDecoder {
  const detector = new ctor({ formats: ['qr_code'] });
  return async (video) => {
    const found = await detector.detect(video);
    const value = found[0]?.rawValue ?? '';
    return value.length > 0 ? value : null;
  };
}

/** Exported for tests: the canvas + jsqr path. */
export function canvasDecoder(createCanvas: () => HTMLCanvasElement): FrameDecoder {
  let canvas: HTMLCanvasElement | null = null;
  return (video) => {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width === 0 || height === 0) return Promise.resolve(null);
    const scale = Math.min(1, MAX_DECODE_SIDE / Math.max(width, height));
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    canvas ??= createCanvas();
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) return Promise.resolve(null);
    context.drawImage(video, 0, 0, w, h);
    const image = context.getImageData(0, 0, w, h);
    const code = jsQR(image.data, w, h, { inversionAttempts: 'dontInvert' });
    return Promise.resolve(code !== null && code.data.length > 0 ? code.data : null);
  };
}

/** Picks the native detector when it reads QR codes, the JS decoder otherwise. */
export async function createFrameDecoder(): Promise<FrameDecoder> {
  const ctor = nativeDetectorClass();
  if (ctor !== null && (await supportsNativeQr(ctor))) return nativeDecoder(ctor);
  return canvasDecoder(() => document.createElement('canvas'));
}
