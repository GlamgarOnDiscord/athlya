'use client';

/**
 * The signed-in studio (`GET /v1/studios/me`) for the console shell: its
 * name feeds the breadcrumb and the sidebar card. `null` while loading or
 * when the read fails; the shell then shows a neutral fallback.
 */
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { useApiClient } from '../../lib/api/buildClient';
import { useAuth } from '../../lib/auth/AuthContext';

import type { StudioMeResponse } from '@athlya/shared/schemas/api';

type StudioSummary = Pick<StudioMeResponse, 'name' | 'slug'>;

const StudioContext = createContext<StudioSummary | null>(null);

export function StudioProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const { accessToken } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);
  const [studio, setStudio] = useState<StudioSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    void client.get<StudioMeResponse>('/v1/studios/me').then(
      (res) => {
        if (!cancelled) setStudio({ name: res.name, slug: res.slug });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  return <StudioContext.Provider value={studio}>{children}</StudioContext.Provider>;
}

export function useStudio(): StudioSummary | null {
  return use(StudioContext);
}
