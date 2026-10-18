/**
 * Base64 to bytes for BLE characteristic values (`react-native-ble-plx`
 * reports them as base64). Dependency-free so it behaves the same in
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
