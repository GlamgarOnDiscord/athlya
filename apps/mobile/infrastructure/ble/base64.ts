/**
 * Base64 <-> bytes for BLE characteristic values (`react-native-ble-plx`
 * exchanges them as base64). Dependency-free so it behaves the same in
 * Hermes and in Node tests; invalid input yields null.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Map<string, number>([...ALPHABET].map((char, index) => [char, index]));

export function base64ToBytes(value: string): Uint8Array | null {
  const input = value.replace(/=+$/u, '');
  if (input.length % 4 === 1) return null;
  const bytes = new Uint8Array(Math.floor((input.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of input) {
    const sextet = LOOKUP.get(char);
    if (sextet === undefined) return null;
    // At most 13 pending bits: keep the buffer within 16 bits.
    buffer = ((buffer << 6) | sextet) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index] = (buffer >> bits) & 0xff;
      index += 1;
    }
  }
  return bytes;
}

/** Bytes to padded base64, for characteristic writes. */
export function bytesToBase64(bytes: Uint8Array): string {
  let output = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const triple = ((bytes[i] ?? 0) << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    output += ALPHABET.charAt((triple >> 18) & 0x3f);
    output += ALPHABET.charAt((triple >> 12) & 0x3f);
    output += b1 === undefined ? '=' : ALPHABET.charAt((triple >> 6) & 0x3f);
    output += b2 === undefined ? '=' : ALPHABET.charAt(triple & 0x3f);
  }
  return output;
}
