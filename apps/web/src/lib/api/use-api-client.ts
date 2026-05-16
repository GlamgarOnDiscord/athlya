import { useMemo } from 'react';

import { refreshAccessToken } from '../auth/refresh';
import { getAccessToken } from '../auth/token-store';
import { getPublicApiUrl } from '../env';
import { createApiClient, type ApiClient } from './client';

/**
 * Returns a referentially stable {@link ApiClient} wired with the
 * in-memory token store and the silent-refresh hook.
 *
 * Pass the optional `clientProp` test seam to inject a fake client in
 * unit tests; omit it in production and the real client is built once.
 */
export function useApiClient(clientProp?: ApiClient): ApiClient {
  return useMemo<ApiClient>(
    () =>
      clientProp ??
      createApiClient({
        baseUrl: getPublicApiUrl(),
        getToken: getAccessToken,
        onRefresh: refreshAccessToken,
      }),
    [clientProp],
  );
}
