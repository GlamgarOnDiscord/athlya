/**
 * Storage of studio logos (issue #761), on the member avatar pattern.
 *
 * Two modes, picked per environment:
 *   - **R2**, when `AVATARS_BUCKET` and `AVATARS_PUBLIC_URL` are both
 *     set: the file goes to `studio-logos/{studioId}/{variant}` in the
 *     avatars bucket (outside the `avatars/` prefix the RGPD cascade
 *     lists) and the stored value is its public URL with a version query
 *     so a replaced logo is not served stale from a cache.
 *   - **data: URL** otherwise: the file is stored inline as
 *     `data:image/...;base64,...` on the studio row, capped by
 *     {@link LOGO_MAX_BYTES} (migration 0053 bounds the column).
 *
 * Either way the bytes must match the declared type (PNG, JPEG or WebP
 * magic bytes, same check as avatars). SVG is refused: it can carry
 * script and is not rendered by most e-mail clients.
 */

import { AVATAR_ALLOWED_TYPES, validateAvatarMagicBytes } from './avatar-upload-store-r2.js';

import type { StudioLogoVariant } from '@athlya/shared/schemas/api';
import type { R2Bucket } from '@cloudflare/workers-types';

/** Largest logo accepted, in bytes (fits the column once base64-encoded). */
export const LOGO_MAX_BYTES = 128 * 1024;

/** Content types accepted for a logo. */
export const LOGO_ALLOWED_TYPES: ReadonlySet<string> = AVATAR_ALLOWED_TYPES;

export function studioLogoObjectKey(studioId: string, variant: StudioLogoVariant): string {
  return `studio-logos/${studioId}/${variant}`;
}

export interface StudioLogoStore {
  /**
   * Store the logo and return the value to save on the studio row.
   *
   * @throws {import('./avatar-upload-store-r2.js').AvatarInvalidFormatError}
   *   when the bytes do not match `contentType`.
   */
  put(
    studioId: string,
    variant: StudioLogoVariant,
    contentType: string,
    body: ArrayBuffer,
  ): Promise<string>;
  /** Drop the stored object, when there is one. */
  remove(studioId: string, variant: StudioLogoVariant): Promise<void>;
}

/** `url` without its trailing slashes, in one linear pass (no regex). */
export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 0x2f) end -= 1;
  return url.slice(0, end);
}

function toBase64(body: ArrayBuffer): string {
  const bytes = new Uint8Array(body);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function createStudioLogoStore(
  bucket: R2Bucket | undefined,
  publicBaseUrl: string | undefined,
  now: () => number = Date.now,
): StudioLogoStore {
  const base =
    publicBaseUrl !== undefined && publicBaseUrl !== ''
      ? trimTrailingSlashes(publicBaseUrl)
      : undefined;
  const r2 = bucket !== undefined && base !== undefined ? { bucket, base } : undefined;

  return {
    async put(studioId, variant, contentType, body) {
      validateAvatarMagicBytes(body, contentType);
      if (r2 === undefined) {
        return `data:${contentType};base64,${toBase64(body)}`;
      }
      const key = studioLogoObjectKey(studioId, variant);
      await r2.bucket.put(key, body, { httpMetadata: { contentType } });
      return `${r2.base}/${key}?v=${String(now())}`;
    },

    async remove(studioId, variant) {
      if (bucket === undefined) return;
      await bucket.delete(studioLogoObjectKey(studioId, variant));
    },
  };
}
