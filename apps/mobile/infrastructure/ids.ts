const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isUuidV4(value: string): boolean {
  return UUID_V4_REGEX.test(value);
}

/** Source of RFC 4122 version-4 UUIDs (`expo-crypto` on device, `node:crypto` in tests). */
export type UuidV4Generator = () => string;
