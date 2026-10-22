import { describe, expect, it, vi } from 'vitest';

import { AvatarInvalidFormatError } from '../../adapters/avatar-upload-store-r2.js';
import {
  createStudioLogoStore,
  studioLogoObjectKey,
  trimTrailingSlashes,
} from '../../adapters/studio-logo-store.js';

import type { R2Bucket } from '@cloudflare/workers-types';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).buffer;
const STUDIO = '0f000000-0000-4000-8000-000000000001';

function fakeBucket() {
  const put = vi.fn(async () => null);
  const del = vi.fn(async () => undefined);
  return { bucket: { put, delete: del } as unknown as R2Bucket, put, del };
}

describe('createStudioLogoStore', () => {
  it('stores the logo inline as a data URL without a bucket', async () => {
    const store = createStudioLogoStore(undefined, undefined);
    await expect(store.put(STUDIO, 'light', 'image/png', PNG)).resolves.toBe(
      'data:image/png;base64,iVBORw0KGgoAAA==',
    );
  });

  it('falls back to a data URL when the public URL is missing', async () => {
    const { bucket, put } = fakeBucket();
    const store = createStudioLogoStore(bucket, '');
    await expect(store.put(STUDIO, 'dark', 'image/png', PNG)).resolves.toMatch(/^data:image\/png/u);
    expect(put).not.toHaveBeenCalled();
  });

  it('uploads to R2 under the studio-logos prefix with a version query', async () => {
    const { bucket, put } = fakeBucket();
    const store = createStudioLogoStore(bucket, 'https://assets.athlya.test/', () => 42);
    await expect(store.put(STUDIO, 'dark', 'image/png', PNG)).resolves.toBe(
      `https://assets.athlya.test/studio-logos/${STUDIO}/dark?v=42`,
    );
    expect(put).toHaveBeenCalledWith(studioLogoObjectKey(STUDIO, 'dark'), PNG, {
      httpMetadata: { contentType: 'image/png' },
    });
  });

  it('refuses bytes that do not match the declared type', async () => {
    const store = createStudioLogoStore(undefined, undefined);
    await expect(store.put(STUDIO, 'light', 'image/jpeg', PNG)).rejects.toBeInstanceOf(
      AvatarInvalidFormatError,
    );
  });

  it('deletes the R2 object on removal, and is a no-op without a bucket', async () => {
    const { bucket, del } = fakeBucket();
    await createStudioLogoStore(bucket, 'https://assets.athlya.test').remove(STUDIO, 'light');
    expect(del).toHaveBeenCalledWith(`studio-logos/${STUDIO}/light`);
    await expect(createStudioLogoStore(undefined, undefined).remove(STUDIO, 'light')).resolves.toBe(
      undefined,
    );
  });
});

describe('trimTrailingSlashes', () => {
  it('drops trailing slashes only', () => {
    expect(trimTrailingSlashes('https://assets.athlya.test///')).toBe('https://assets.athlya.test');
    expect(trimTrailingSlashes('https://a.test/x')).toBe('https://a.test/x');
    expect(trimTrailingSlashes('///')).toBe('');
  });

  it('stays linear on a long run of slashes', () => {
    const input = `https://a.test${'/'.repeat(200_000)}x${'/'.repeat(200_000)}`;
    const started = performance.now();
    expect(trimTrailingSlashes(input)).toBe(`https://a.test${'/'.repeat(200_000)}x`);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
