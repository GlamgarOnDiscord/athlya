import { CoachStatusResponseSchema } from '@athlya/shared/schemas/api';
import { useEffect, useState } from 'react';

import type { ApiClient } from '../../../lib/api/client';

/**
 * Whether `GET /v1/coach` reports the `ai-coach` flag on for the member.
 * False while loading, when the flag is off, on error and while `active`
 * is false (no request is sent then).
 */
export function useCoachEnabled(client: ApiClient, active = true): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    client
      .get<unknown>('/v1/coach')
      .then((raw) => {
        const parsed = CoachStatusResponseSchema.safeParse(raw);
        if (!cancelled) setEnabled(parsed.success && parsed.data.enabled);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, active]);

  return active && enabled;
}
