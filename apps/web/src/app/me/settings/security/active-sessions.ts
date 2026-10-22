/**
 * Active sessions of the member (issue #757): `GET /v1/auth/sessions`
 * and `DELETE /v1/auth/sessions/:id`, plus the labels the list shows.
 */
import type { ApiClient } from '../../../../lib/api/client';
import type { Translator } from '../../../../lib/i18n/t';
import type { ActiveSession } from '@athlya/shared/schemas/api';

export async function fetchActiveSessions(
  client: Pick<ApiClient, 'get'>,
): Promise<ReadonlyArray<ActiveSession>> {
  const res = await client.get<{ items: ReadonlyArray<ActiveSession> }>('/v1/auth/sessions');
  return res.items;
}

export async function revokeActiveSession(
  client: Pick<ApiClient, 'del'>,
  id: string,
): Promise<void> {
  await client.del(`/v1/auth/sessions/${encodeURIComponent(id)}`);
}

/** "Chrome on macOS", or the unknown-device label for a session without one. */
export function deviceLabel(session: Pick<ActiveSession, 'device'>, t: Translator): string {
  if (session.device === null) return t('web.settings.security.sessions.unknownDevice');
  return t('web.settings.security.sessions.device', {
    browser: t(`web.settings.security.sessions.browser.${session.device.browser}`),
    os: t(`web.settings.security.sessions.os.${session.device.os}`),
  });
}

/** When the device was last active, in the reader's locale. */
export function lastSeenLabel(
  session: Pick<ActiveSession, 'lastSeenAt' | 'createdAt'>,
  locale: string,
  t: Translator,
): string {
  const at = session.lastSeenAt ?? session.createdAt;
  if (at === null) return t('web.settings.security.sessions.unknownTime');
  const date = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(at));
  return t('web.settings.security.sessions.lastSeen', { date });
}

/** The caller's own session first, then the most recently active. */
export function orderSessions(
  sessions: ReadonlyArray<ActiveSession>,
): ReadonlyArray<ActiveSession> {
  const seen = (s: ActiveSession): string => s.lastSeenAt ?? s.createdAt ?? '';
  return [...sessions].sort(
    (a, b) => Number(b.current) - Number(a.current) || seen(b).localeCompare(seen(a)),
  );
}
