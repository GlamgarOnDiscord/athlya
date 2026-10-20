/**
 * Where the member lands after signing in or registering.
 *
 * The default is `/classes`, the page a member signs in to use. A `next`
 * (or `redirect`) query parameter wins when it names a path of this site;
 * anything else (another origin, a protocol-relative `//host`, a
 * backslash some browsers read as a slash, a tab or newline the URL parser
 * strips) falls back to the default, so the parameter cannot send the
 * member to another site.
 */

export const DEFAULT_POST_AUTH_PATH = '/classes';

/** Query parameters read, in order, for the destination. */
const DESTINATION_PARAMS = ['next', 'redirect'] as const;

/** Placeholder origin a path is resolved against; never requested. */
const PROBE_ORIGIN = 'https://local.invalid';

/** Control characters (stripped by the URL parser) and backslashes. */
const UNSAFE_CHARACTERS = /[\p{Cc}\\]/u;

function isSafeLocalPath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  if (UNSAFE_CHARACTERS.test(value)) return false;
  try {
    return new URL(value, PROBE_ORIGIN).origin === PROBE_ORIGIN;
  } catch {
    return false;
  }
}

/** The path to push after a successful sign-in, from the page's query string. */
export function postAuthDestination(search: string): string {
  const params = new URLSearchParams(search);
  for (const name of DESTINATION_PARAMS) {
    const value = params.get(name);
    if (value !== null && isSafeLocalPath(value)) return value;
  }
  return DEFAULT_POST_AUTH_PATH;
}
