/**
 * R2-backed adapter for member avatar uploads (N2.13).
 *
 * Implements the upload side of the avatar lifecycle — the deletion
 * side (`deleteAvatar`) lives in `avatar-store-r2.ts` and is consumed
 * by the RGPD cascade.
 *
 * Key layout
 * ----------
 * `avatars/{userId}/avatar` — stable key independent of content type so
 * re-uploading with a different format overwrites the previous object
 * without leaving orphaned keys. The MIME type is preserved via
 * `httpMetadata.contentType` on the R2 object. The key is namespaced
 * under `avatars/` so the cascade's `list({ prefix: 'avatars/{userId}/' })`
 * loop picks it up without any extra enumeration logic.
 *
 * Mode dégradé
 * ------------
 * When `AVATARS_BUCKET` or `AVATARS_PUBLIC_URL` is absent the factory
 * returns a store that throws {@link AvatarUploadNotConfiguredError}
 * on `putAvatar`. The route handler catches this and returns 503 with
 * `code: 'avatar_upload_not_configured'`, matching the pattern used
 * by billing (`billing_not_configured`) and exports
 * (`exports_bucket_missing`). The public URL check runs BEFORE the R2
 * put so no orphaned objects are written on misconfigured deployments.
 */

import type { R2Bucket } from '@cloudflare/workers-types';

/* ------------------------------------------------------------------ */
/*  Public constants                                                   */
/* ------------------------------------------------------------------ */

/** Binary upload limit enforced by the Worker before writing to R2. */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/** MIME types accepted by the upload endpoint. */
export const AVATAR_ALLOWED_TYPES = new Set<string>(['image/jpeg', 'image/png', 'image/webp']);

/* ------------------------------------------------------------------ */
/*  Stable error class                                                 */
/* ------------------------------------------------------------------ */

/** Thrown when the R2 bucket binding or public base URL is missing. */
export class AvatarUploadNotConfiguredError extends Error {
  public constructor(reason: string) {
    super(reason);
    this.name = 'AvatarUploadNotConfiguredError';
  }
}

/* ------------------------------------------------------------------ */
/*  Key helper                                                         */
/* ------------------------------------------------------------------ */

/**
 * Build the stable R2 object key for a user's avatar.
 *
 * No extension — content type is preserved via `httpMetadata.contentType`
 * so re-uploading with a different format overwrites the same key.
 * Exported for tests and for the RGPD cascade's prefix enumeration.
 */
export function avatarObjectKey(userId: string): string {
  return `avatars/${userId}/avatar`;
}

/* ------------------------------------------------------------------ */
/*  Port                                                               */
/* ------------------------------------------------------------------ */

export interface AvatarUploadStore {
  /**
   * Upload `body` to R2 and return the public URL for the stored object.
   *
   * @throws {AvatarUploadNotConfiguredError} when the bucket or public
   *   base URL is not provisioned.
   */
  putAvatar(userId: string, contentType: string, body: ArrayBuffer): Promise<string>;
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build an R2-backed {@link AvatarUploadStore}.
 *
 * @param bucket        - `AVATARS_BUCKET` Worker binding (optional).
 * @param publicBaseUrl - Base URL prepended to the key to form the
 *   public avatar URL (e.g. `https://avatars.athlya.app`). When absent,
 *   throws {@link AvatarUploadNotConfiguredError} — the check runs
 *   BEFORE the R2 put to avoid writing orphaned objects.
 * @param envName       - `ENVIRONMENT` value, included in warn logs.
 */
export function createR2AvatarUploadStore(
  bucket: R2Bucket | undefined,
  publicBaseUrl: string | undefined,
  envName: string | undefined = 'unknown',
): AvatarUploadStore {
  return {
    async putAvatar(userId, contentType, body) {
      if (bucket === undefined) {
        console.warn(
          '[avatar-upload-store-r2] AVATARS_BUCKET binding missing — rejecting upload (mode dégradé)',
          { userId, env: envName },
        );
        throw new AvatarUploadNotConfiguredError('AVATARS_BUCKET not bound');
      }

      if (!publicBaseUrl) {
        console.warn(
          '[avatar-upload-store-r2] AVATARS_PUBLIC_URL not set — rejecting upload (mode dégradé)',
          { userId, env: envName },
        );
        throw new AvatarUploadNotConfiguredError('AVATARS_PUBLIC_URL not configured');
      }

      const key = avatarObjectKey(userId);

      await bucket.put(key, body, {
        httpMetadata: { contentType },
      });

      const base = publicBaseUrl.endsWith('/') ? publicBaseUrl.slice(0, -1) : publicBaseUrl;
      return `${base}/${key}`;
    },
  };
}
