/**
 * Signed download links for RGPD export archives (issue #498).
 *
 * R2 bindings cannot presign URLs, so the archive is served by the API
 * (`GET /v1/members/me/export/:jobId/download`). The link carries an
 * expiry and an HMAC-SHA256 over `jobId.exp` keyed by
 * `EXPORT_URL_SIGNING_KEY`; the route additionally requires the owner's
 * JWT, and reads the job through the `export_jobs_read_own` policy. A
 * leaked link is therefore useless without the owner's session, and a
 * stolen session cannot mint links for other jobs or extend the expiry.
 */

/** Stable failure reason when the signing key or public base URL is unset. */
export const EXPORT_DOWNLOAD_NOT_CONFIGURED_REASON = 'export_download_not_configured';

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  // A length of 1 mod 4 is never valid base64 and makes `atob` throw.
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) return null;
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/');
  let binary: string;
  try {
    binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** HMAC signature (base64url) binding `jobId` to the expiry `exp` (epoch seconds). */
export async function signExportDownload(
  secret: string,
  jobId: string,
  exp: number,
): Promise<string> {
  const key = await hmacKey(secret);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${jobId}.${exp}`));
  return toBase64Url(new Uint8Array(mac));
}

/** Constant-time verification of a link; rejects expired or malformed links. */
export async function verifyExportDownload(
  secret: string,
  jobId: string,
  exp: number,
  sig: string,
  nowSec: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(exp) || exp <= nowSec) return false;
  const mac = fromBase64Url(sig);
  if (mac === null || mac.length !== 32) return false;
  const key = await hmacKey(secret);
  return crypto.subtle.verify('HMAC', key, mac, encoder.encode(`${jobId}.${exp}`));
}

/** Absolute download link for `jobId`, valid until `exp`. */
export async function buildExportDownloadUrl(
  baseUrl: string,
  secret: string,
  jobId: string,
  exp: number,
): Promise<string> {
  const sig = await signExportDownload(secret, jobId, exp);
  const url = new URL(`/v1/members/me/export/${encodeURIComponent(jobId)}/download`, baseUrl);
  url.searchParams.set('exp', String(exp));
  url.searchParams.set('sig', sig);
  return url.toString();
}
