import type { ApiClient } from '../../../../lib/api/client';

/**
 * Revokes every refresh token of the member (`POST /v1/auth/logout-all`),
 * then clears this browser's session. Resolves `false`, with the local
 * session left untouched, when the API call fails: the member must not
 * believe their other devices are signed out when they are not.
 */
export async function signOutEverywhere(
  client: Pick<ApiClient, 'post'>,
  signOutLocally: () => Promise<void>,
): Promise<boolean> {
  try {
    await client.post('/v1/auth/logout-all', {});
  } catch {
    return false;
  }
  await signOutLocally();
  return true;
}
