/**
 * Per-request CSP nonce generator. Identical to
 * `apps/web/src/lib/nonce.ts` — see the rationale there for why we
 * hold off on `import 'server-only'`.
 *
 * @see Req 25.3.
 */

const NONCE_BYTE_LENGTH = 16;

export function generateNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 =
    typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}
