/**
 * Where the member lands after signing in or registering.
 *
 * The default is `/classes`, the page a member signs in to use. A `next`
 * (or `redirect`) query parameter wins when it names a path of this site;
 * anything else (another origin, a protocol-relative `//host`, a
 * backslash some browsers read as a slash) falls back to the default, so
 * the parameter cannot send the member to another site.
 */

export const DEFAULT_POST_AUTH_PATH = '/classes';

/** Query parameters read, in order, for the destination. */
const DESTINATION_PARAMS = ['next', 'redirect'] as const;

function isSafeLocalPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\');
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
